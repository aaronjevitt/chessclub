// Play on Lichess from the club app: members link their Lichess account (OAuth with PKCE, no app
// registration needed), then seek a random opponent, challenge a Lichess user or play the Lichess
// computer, all on our board. The server holds each member's token and their live Lichess streams
// (Board API) and relays the games to the member's browser over Socket.IO.
//
// Ratings: Lichess games are rated by Lichess and change only the player's Lichess rating. They never
// touch club ratings (a different pool of opponents). Finished games are imported as private games so
// they can be reviewed here and feed the player's puzzles.
import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { START_FEN } from './chesslogic.js';

export const LICHESS_SCOPES = 'board:play challenge:read challenge:write';
// The Board API only allows rapid or slower for seeks; direct challenges and the Lichess computer
// also allow blitz. Lichess estimates a game's length as initial time + 40 × increment.
export const SEEK_MIN_SECONDS = 8 * 60;
export const CHALLENGE_MIN_SECONDS = 3 * 60;
const STATE_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_REFRESH_MS = 10 * 60 * 1000;
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const FINISHED = new Set(['aborted', 'mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime', 'cheat', 'noStart', 'unknownFinish', 'insufficientMaterialClaim', 'variantEnd']);
const TERMINATION = {
  mate: 'checkmate', resign: 'resignation', stalemate: 'stalemate', timeout: 'opponent left', draw: 'draw',
  outoftime: 'time', insufficientMaterialClaim: 'insufficient material', cheat: 'fair play', unknownFinish: 'finished',
};

export const estimatedSeconds = (limit, increment) => limit + 40 * increment;

/** Check a clock for the Board API. kind: 'seek' (rapid+) or 'challenge' / 'ai' (blitz+). Returns an error message or null. */
export function clockProblem({ limit, increment }, kind) {
  if (!Number.isInteger(limit) || !Number.isInteger(increment) || limit < 0 || increment < 0 || increment > 180) return 'Choose a time control';
  // Lichess accepts 0, 15, 30, 45, 60, 90 seconds or whole minutes up to 3 hours.
  if (!([0, 15, 30, 45, 60, 90].includes(limit) || (limit % 60 === 0 && limit <= 10800))) return 'Initial time must be whole minutes (up to 180)';
  const min = kind === 'seek' ? SEEK_MIN_SECONDS : CHALLENGE_MIN_SECONDS;
  if (estimatedSeconds(limit, increment) < min) {
    return kind === 'seek'
      ? 'Lichess only pairs apps like this one in rapid or slower games (e.g. 10+0 or 15+10)'
      : 'Lichess only allows blitz or slower games from apps like this one (e.g. 3+2 or 5+3)';
  }
  return null;
}

/**
 * Replay Lichess's UCI move list. Castling may come as king-takes-own-rook (e1h1), which chess.js
 * doesn't accept, so that is translated to the king's destination square.
 */
export function replayUci(initialFen, uciMoves) {
  const chess = new Chess(initialFen && initialFen !== 'startpos' ? initialFen : START_FEN);
  let lastMove = null;
  for (const uci of uciMoves) {
    const from = uci.slice(0, 2);
    let to = uci.slice(2, 4);
    const piece = chess.get(from);
    const target = chess.get(to);
    if (piece?.type === 'k' && target?.type === 'r' && target.color === piece.color) to = `${to < from ? 'c' : 'g'}${from[1]}`;
    const move = chess.move({ from, to, promotion: uci[4] });
    lastMove = { from: move.from, to: move.to };
  }
  return { chess, lastMove };
}

/** Our result string for a finished Lichess game, or null if it didn't really happen (aborted). */
export function lichessResult(status, winner) {
  if (status === 'aborted' || status === 'noStart') return null;
  if (winner === 'white') return '1-0';
  if (winner === 'black') return '0-1';
  return '1/2-1/2';
}

/** Read an NDJSON response line by line (empty keep-alive lines skipped). */
async function* ndjson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // ignore a malformed line
      }
    }
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function registerLichess({ app, db, io, q, HttpError, cleanText, push, host = process.env.LICHESS_HOST || 'https://lichess.org' }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lichess_accounts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lichess_id TEXT NOT NULL,
      username TEXT NOT NULL,
      token TEXT NOT NULL,
      perfs TEXT,
      perfs_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lichess_imports (
      lichess_game_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      PRIMARY KEY (lichess_game_id, user_id)
    );`);
  // Members' live Lichess games show in their clubs unless they turn it off (their games are public on Lichess anyway).
  try {
    db.exec('ALTER TABLE lichess_accounts ADD COLUMN share_in_club INTEGER NOT NULL DEFAULT 1');
  } catch {
    // already there
  }
  const s = {
    account: db.prepare('SELECT * FROM lichess_accounts WHERE user_id = ?'),
    upsert: db.prepare(`INSERT INTO lichess_accounts (user_id, lichess_id, username, token, perfs, perfs_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET lichess_id = excluded.lichess_id, username = excluded.username, token = excluded.token,
        perfs = excluded.perfs, perfs_at = excluded.perfs_at`),
    setPerfs: db.prepare('UPDATE lichess_accounts SET perfs = ?, perfs_at = ? WHERE user_id = ?'),
    remove: db.prepare('DELETE FROM lichess_accounts WHERE user_id = ?'),
    imported: db.prepare('SELECT game_id FROM lichess_imports WHERE lichess_game_id = ? AND user_id = ?'),
    addImport: db.prepare('INSERT OR IGNORE INTO lichess_imports (lichess_game_id, user_id, game_id) VALUES (?, ?, ?)'),
    homeClub: db.prepare('SELECT club_id FROM memberships WHERE user_id = ? ORDER BY joined_at LIMIT 1'),
    setShare: db.prepare('UPDATE lichess_accounts SET share_in_club = ? WHERE user_id = ?'),
    clubsOf: db.prepare('SELECT club_id FROM memberships WHERE user_id = ?'),
    sharesClub: db.prepare('SELECT 1 FROM memberships a JOIN memberships b ON a.club_id = b.club_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1'),
    isMember: db.prepare('SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ?'),
    clubName: db.prepare('SELECT name FROM clubs WHERE id = ?'),
  };
  const pending = new Map(); // OAuth state -> {userId, verifier, redirectUri, clientId, at}
  const sessions = new Map(); // userId -> session

  // ---------- Lichess HTTP ----------

  function call(token, path, { method = 'GET', form, signal } = {}) {
    return fetch(host + path, {
      method,
      signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) : undefined,
    });
  }

  /** Turn a failed Lichess response into an error for our client (never a 401: that would log them out here). */
  async function lichessError(res, userId) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      if (userId) forget(userId);
      return new HttpError(409, 'Your Lichess connection has expired — connect it again on your profile');
    }
    if (res.status === 429) return new HttpError(429, 'Lichess is rate limiting requests — wait a minute and try again');
    const message = body.error || body.error_description || (typeof body.message === 'string' ? body.message : null);
    return new HttpError(res.status >= 500 ? 502 : 400, message ? `Lichess: ${message}` : `Lichess returned an error (${res.status})`);
  }

  async function callJson(token, path, opts = {}, userId = null) {
    let res;
    try {
      res = await call(token, path, opts);
    } catch {
      throw new HttpError(502, "Couldn't reach Lichess");
    }
    if (!res.ok) throw await lichessError(res, userId);
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }

  // ---------- sessions: one live event stream per connected member ----------

  function emit(userId, event, data) {
    io.to(`user:${userId}`).emit(event, data);
  }

  function session(userId) {
    let sess = sessions.get(userId);
    if (sess) return sess;
    const account = s.account.get(userId);
    if (!account) return null;
    sess = {
      userId, account, events: null, eventsReady: null, games: new Map(), challenges: new Map(),
      seek: null, outgoing: null, idleTimer: null, retryTimer: null, closed: false,
    };
    sessions.set(userId, sess);
    return sess;
  }

  function forget(userId) {
    const sess = sessions.get(userId);
    if (sess) closeSession(sess);
    s.remove.run(userId);
    emit(userId, 'lichess:changed', {});
  }

  function closeSession(sess) {
    sess.closed = true;
    clearTimeout(sess.idleTimer);
    clearTimeout(sess.retryTimer);
    sess.events?.abort();
    sess.seek?.ac.abort();
    sess.outgoing?.ac.abort();
    for (const g of sess.games.values()) g.ac?.abort();
    sessions.delete(sess.userId);
  }

  /** Open the event stream if it isn't open; resolves once Lichess has answered (so a seek can't race it). */
  function ensureEvents(sess) {
    if (sess.events && !sess.events.signal.aborted) return sess.eventsReady;
    const ac = new AbortController();
    sess.events = ac;
    sess.eventsReady = (async () => {
      let res;
      try {
        res = await call(sess.account.token, '/api/stream/event', { signal: ac.signal });
      } catch {
        if (!ac.signal.aborted) retryEvents(sess, 5000);
        return false;
      }
      if (!res.ok) {
        if (res.status === 401) forget(sess.userId);
        else retryEvents(sess, res.status === 429 ? 60000 : 10000);
        return false;
      }
      readEvents(sess, res, ac);
      return true;
    })();
    return sess.eventsReady;
  }

  function retryEvents(sess, ms) {
    sess.events = null;
    if (sess.closed) return;
    clearTimeout(sess.retryTimer);
    sess.retryTimer = setTimeout(() => {
      if (!sess.closed && wanted(sess)) ensureEvents(sess);
    }, ms);
  }

  async function readEvents(sess, res, ac) {
    try {
      for await (const ev of ndjson(res)) handleEvent(sess, ev);
    } catch {
      // stream dropped
    }
    if (!ac.signal.aborted) retryEvents(sess, 3000);
  }

  function handleEvent(sess, ev) {
    const me = sess.account.lichess_id;
    if (ev.type === 'gameStart' && ev.game?.gameId) {
      const info = ev.game;
      watchGame(sess, info.gameId);
      emit(sess.userId, 'lichess:gameStart', { id: info.gameId });
      emit(sess.userId, 'lichess:changed', {});
    } else if (ev.type === 'gameFinish' && ev.game?.gameId) {
      // The game stream doesn't carry rating changes; the finish event has ours.
      const g = sess.games.get(ev.game.gameId);
      if (g && typeof ev.game.ratingDiff === 'number') {
        g.myRatingDiff = ev.game.ratingDiff;
        if (g.importedId) {
          const row = q.game.get(g.importedId);
          const meta = JSON.parse(row.meta);
          meta.lichess[`${meta.playerColor}RatingDiff`] = ev.game.ratingDiff;
          db.prepare('UPDATE games SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
        }
        emit(sess.userId, 'lichess:game', snapshot(sess, g));
      }
      refreshAccount(sess.userId, true);
      emit(sess.userId, 'lichess:changed', {});
    } else if (ev.type === 'challenge' && ev.challenge?.id) {
      const c = ev.challenge;
      if (c.challenger?.id !== me) {
        sess.challenges.set(c.id, c);
        push?.notifyUser(sess.userId, {
          title: 'Lichess challenge', body: `${c.challenger?.name || 'Someone'} challenges you on Lichess (${c.timeControl?.show || c.speed})`,
          url: '/#/', tag: `lichess-challenge-${c.id}`,
        }, { unlessOnline: true }).catch(() => {});
      }
      emit(sess.userId, 'lichess:changed', {});
    } else if ((ev.type === 'challengeCanceled' || ev.type === 'challengeDeclined') && ev.challenge?.id) {
      sess.challenges.delete(ev.challenge.id);
      if (ev.type === 'challengeDeclined' && sess.outgoing?.id === ev.challenge.id) {
        emit(sess.userId, 'lichess:notice', { message: `${ev.challenge.destUser?.name || 'Your opponent'} declined the challenge` });
      }
      emit(sess.userId, 'lichess:changed', {});
    }
  }

  /** Whether the session still has a reason to keep its streams open. */
  function wanted(sess) {
    const online = io.sockets.adapter.rooms.get(`user:${sess.userId}`)?.size > 0;
    return online || sess.seek || sess.outgoing || [...sess.games.values()].some((g) => !g.finished);
  }

  function scheduleIdleCheck(sess) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = setTimeout(() => {
      if (!wanted(sess)) closeSession(sess);
    }, IDLE_CLOSE_MS);
  }

  // ---------- games ----------

  function snapshot(sess, g) {
    if (!g.full) return { id: g.id, loading: true };
    const st = g.state || g.full.state || {};
    const uci = (st.moves || '').split(' ').filter(Boolean);
    let fen = null;
    let sans = [];
    let lastMove = null;
    try {
      const r = replayUci(g.full.initialFen, uci);
      fen = r.chess.fen();
      sans = r.chess.history();
      lastMove = r.lastMove;
    } catch {
      // keep what we can show
    }
    const player = (p) => ({ id: p?.id || null, name: p?.name || (p?.aiLevel ? `Lichess AI level ${p.aiLevel}` : '?'), rating: p?.rating ?? null, ratingDiff: p?.ratingDiff ?? null, provisional: !!p?.provisional, title: p?.title || null, aiLevel: p?.aiLevel || null });
    const me = sess.account.lichess_id;
    const myColor = g.full.white?.id === me ? 'white' : g.full.black?.id === me ? 'black' : null;
    const white = player(g.full.white);
    const black = player(g.full.black);
    if (myColor && g.myRatingDiff != null) (myColor === 'white' ? white : black).ratingDiff ??= g.myRatingDiff;
    return {
      id: g.id,
      url: `${host}/${g.id}`,
      myColor,
      white,
      black,
      rated: !!g.full.rated,
      speed: g.full.speed,
      clock: g.full.clock || null,
      initialFen: g.full.initialFen && g.full.initialFen !== 'startpos' ? g.full.initialFen : START_FEN,
      moves: sans,
      fen,
      lastMove,
      wtime: st.wtime ?? null,
      btime: st.btime ?? null,
      sentAt: g.stateAt,
      status: st.status || 'started',
      winner: st.winner || null,
      drawOffer: st.wdraw ? 'white' : st.bdraw ? 'black' : null,
      opponentGone: g.opponentGone || null,
      finished: g.finished,
      importedId: g.importedId || null,
    };
  }

  function watchGame(sess, id) {
    let g = sess.games.get(id);
    if (g && (g.ac && !g.ac.signal.aborted)) return g;
    if (!g) {
      g = { id, full: null, state: null, stateAt: null, finished: false, importedId: s.imported.get(id, sess.userId)?.game_id || null, ac: null, opponentGone: null };
      sess.games.set(id, g);
    }
    if (g.finished) return g;
    const ac = new AbortController();
    g.ac = ac;
    (async () => {
      let res;
      try {
        res = await call(sess.account.token, `/api/board/game/stream/${encodeURIComponent(id)}`, { signal: ac.signal });
      } catch {
        return;
      }
      if (!res.ok) {
        g.error = res.status === 404 ? 'Game not found on Lichess' : `Lichess returned an error (${res.status})`;
        emit(sess.userId, 'lichess:game', { id, error: g.error });
        return;
      }
      try {
        for await (const ev of ndjson(res)) {
          if (ev.type === 'gameFull') {
            g.full = ev;
            g.state = ev.state;
          } else if (ev.type === 'gameState') {
            const before = g.state?.moves || '';
            g.state = ev;
            notifyTurn(sess, g, before);
          } else if (ev.type === 'opponentGone') {
            g.opponentGone = ev.gone ? { claimWinInSeconds: ev.claimWinInSeconds ?? null } : null;
          } else continue;
          g.stateAt = Date.now();
          if (FINISHED.has(g.state?.status)) finishGame(sess, g);
          emit(sess.userId, 'lichess:game', snapshot(sess, g));
          broadcast(sess, g);
          if (g.finished) break;
        }
      } catch {
        // stream dropped
      }
      if (!g.finished && !ac.signal.aborted && !sess.closed) setTimeout(() => watchGame(sess, id), 3000);
    })();
    return g;
  }

  // ---------- watching members' games ----------

  const sharing = (sess) => !!sess.account.share_in_club;

  /** What spectators see: the same game, without the player's private bits. */
  function spectatorSnapshot(sess, g) {
    const snap = snapshot(sess, g);
    return { ...snap, myColor: null, importedId: null, owner: { id: sess.userId, username: q.userName.get(sess.userId)?.username } };
  }

  /** Relay a game update to clubmates watching it, and refresh the member's club pages. */
  function broadcast(sess, g) {
    if (!sharing(sess) || !g.full) return;
    io.to(`lichess:${g.id}`).except(`user:${sess.userId}`).emit('lichess:game', spectatorSnapshot(sess, g));
    for (const { club_id: clubId } of s.clubsOf.all(sess.userId)) io.to(`club:${clubId}`).emit('club:changed', { clubId });
  }

  /** The member's session holding a shared live game, if the viewer may watch it. */
  function sharedGame(viewerId, id) {
    for (const sess of sessions.values()) {
      const g = sess.games.get(id);
      if (!g || !g.full || !sharing(sess) || sess.userId === viewerId) continue;
      if (s.sharesClub.get(viewerId, sess.userId)) return { sess, g };
    }
    return null;
  }

  /** A shared live game in the shape the club page and projector use for club games. */
  function clubShape(sess, g, clubName) {
    const snap = snapshot(sess, g);
    const turn = snap.fen?.split(' ')[1] || 'w';
    const running = snap.moves.length >= 2 ? turn : null;
    return {
      id: `lichess-${g.id}`,
      href: `#/lichess/${g.id}`,
      source: 'lichess',
      mode: 'lichess',
      visibility: 'club',
      status: 'active',
      result: '*',
      white: { id: null, name: snap.white.name, rating: snap.white.rating },
      black: { id: null, name: snap.black.name, rating: snap.black.rating },
      member: { id: sess.userId, username: q.userName.get(sess.userId)?.username, color: snap.myColor },
      startFen: snap.initialFen,
      fen: snap.fen,
      turn,
      moves: snap.moves,
      meta: { rated: snap.rated, lichessUrl: snap.url },
      timeControl: snap.clock?.initial != null ? { initial: snap.clock.initial / 1000, increment: snap.clock.increment / 1000 } : null,
      // Lichess reports each side's time as of its last update; count down from when we received it.
      clock: snap.wtime != null ? {
        white: Math.max(0, snap.wtime - (running === 'w' ? Date.now() - g.stateAt : 0)),
        black: Math.max(0, snap.btime - (running === 'b' ? Date.now() - g.stateAt : 0)),
        running,
      } : null,
      clubName,
      updatedAt: g.stateAt,
      createdAt: g.full.createdAt,
    };
  }

  /** "Your move" push when the member doesn't have the game open. */
  function notifyTurn(sess, g, movesBefore) {
    if (!push || !g.full || (g.state.moves || '') === movesBefore || FINISHED.has(g.state.status)) return;
    const snap = snapshot(sess, g);
    const turn = snap.moves.length % 2 === 0 ? 'white' : 'black';
    if (turn !== snap.myColor) return;
    const opponent = snap.myColor === 'white' ? snap.black : snap.white;
    push.notifyUser(sess.userId, { title: 'Your move on Lichess', body: `${opponent.name} played ${snap.moves.at(-1)}`, url: `/#/lichess/${g.id}`, tag: `lichess-${g.id}` },
      { unlessWatching: `lichess:${g.id}` }).catch(() => {});
  }

  function finishGame(sess, g) {
    if (g.finished) return;
    g.finished = true;
    g.ac?.abort();
    try {
      importGame(sess, g);
    } catch (err) {
      console.error('Lichess import failed:', err.message);
    }
    emit(sess.userId, 'lichess:changed', {});
    emit(sess.userId, 'mygames:changed');
  }

  /** Save a finished Lichess game as a private game in the member's first club, for review and puzzles. */
  function importGame(sess, g) {
    if (g.importedId || !g.full) return;
    const existing = s.imported.get(g.id, sess.userId);
    if (existing) {
      g.importedId = existing.game_id;
      return;
    }
    const snap = snapshot(sess, g);
    const result = lichessResult(snap.status, snap.winner);
    const club = s.homeClub.get(sess.userId);
    if (!result || !club || !snap.moves.length) return;
    const user = q.userName.get(sess.userId);
    const name = (p, color) => cleanText(p.name, 40) || (snap.myColor === color ? user.username : color === 'white' ? 'White' : 'Black');
    const tc = snap.clock?.initial != null ? `${Math.round(snap.clock.initial / 60000 * 10) / 10}+${Math.round(snap.clock.increment / 1000)}` : null;
    const meta = {
      playerColor: snap.myColor,
      event: `Lichess ${snap.rated ? 'rated' : 'casual'} ${snap.speed || 'game'}`,
      site: snap.url,
      date: new Date(g.full.createdAt || Date.now()).toISOString().slice(0, 10).replace(/-/g, '.'),
      lichess: { id: g.id, url: snap.url, rated: snap.rated, speed: snap.speed, whiteRatingDiff: snap.white.ratingDiff, blackRatingDiff: snap.black.ratingDiff },
      ...(snap.white.rating ? { whiteElo: String(snap.white.rating) } : {}),
      ...(snap.black.rating ? { blackElo: String(snap.black.rating) } : {}),
      ...(tc ? { pgnTimeControl: tc } : {}),
    };
    const now = Date.now();
    const { lastInsertRowid } = q.insertGame.run(
      club.club_id, 'import', 'private', 'finished', sess.userId, null, null,
      name(snap.white, 'white'), name(snap.black, 'black'), null, null,
      snap.initialFen, snap.fen, JSON.stringify(snap.moves), result,
      TERMINATION[snap.status] || 'finished', JSON.stringify(meta), now, now, null, null, null, null,
    );
    g.importedId = Number(lastInsertRowid);
    s.addImport.run(g.id, sess.userId, g.importedId);
  }

  // ---------- public helpers ----------

  function requireSession(req) {
    const sess = session(req.user.id);
    if (!sess) throw new HttpError(409, 'Connect your Lichess account on your profile first');
    clearTimeout(sess.idleTimer);
    return sess;
  }

  async function refreshAccount(userId, force = false) {
    const account = s.account.get(userId);
    if (!account) return null;
    if (!force && account.perfs_at && Date.now() - account.perfs_at < ACCOUNT_REFRESH_MS) return account;
    try {
      const me = await callJson(account.token, '/api/account', {}, userId);
      s.setPerfs.run(JSON.stringify(me.perfs || {}), Date.now(), userId);
    } catch {
      // keep the cached ratings
    }
    return s.account.get(userId);
  }

  /** Lichess ratings worth showing: the standard speeds a member actually played. */
  function ratings(account) {
    const perfs = account?.perfs ? JSON.parse(account.perfs) : {};
    return ['bullet', 'blitz', 'rapid', 'classical', 'correspondence']
      .filter((k) => perfs[k]?.games > 0)
      .map((k) => ({ speed: k, rating: perfs[k].rating, games: perfs[k].games, provisional: !!perfs[k].prov }));
  }

  // ---------- OAuth ----------

  function baseUrl(req) {
    return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  }

  // Not under /api: Lichess sends the browser back here, so finish with a redirect to the app.
  app.get('/lichess/callback', async (req, res) => {
    const back = (status) => res.redirect(`/#/player/${req.user?.id ?? ''}?lichess=${status}`);
    const entry = pending.get(String(req.query.state || ''));
    pending.delete(String(req.query.state || ''));
    if (!req.user || !entry || entry.userId !== req.user.id || Date.now() - entry.at > STATE_TTL_MS) return back('expired');
    if (req.query.error || !req.query.code) return back(req.query.error === 'access_denied' ? 'cancelled' : 'failed');
    try {
      const tokenRes = await call(null, '/api/token', {
        method: 'POST',
        form: { grant_type: 'authorization_code', code: String(req.query.code), code_verifier: entry.verifier, redirect_uri: entry.redirectUri, client_id: entry.clientId },
      });
      if (!tokenRes.ok) return back('failed');
      const { access_token: token } = await tokenRes.json();
      const accountRes = await call(token, '/api/account');
      if (!accountRes.ok) return back('failed');
      const me = await accountRes.json();
      const old = sessions.get(req.user.id);
      if (old) closeSession(old);
      s.upsert.run(req.user.id, String(me.id), cleanText(me.username, 40) || String(me.id), token, JSON.stringify(me.perfs || {}), Date.now(), Date.now());
      back('connected');
    } catch {
      back('failed');
    }
  });

  app.post('/api/lichess/connect', (req, res) => {
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(18));
    const base = baseUrl(req);
    const redirectUri = `${base}/lichess/callback`;
    const clientId = new URL(base).host;
    for (const [key, v] of pending) if (Date.now() - v.at > STATE_TTL_MS) pending.delete(key);
    pending.set(state, { userId: req.user.id, verifier, redirectUri, clientId, at: Date.now() });
    const url = new URL(`${host}/oauth`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge_method: 'S256', code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      scope: LICHESS_SCOPES, state,
    }).toString();
    res.json({ url: url.toString() });
  });

  app.post('/api/lichess/disconnect', async (req, res) => {
    const account = s.account.get(req.user.id);
    if (account) await call(account.token, '/api/token', { method: 'DELETE' }).catch(() => {});
    forget(req.user.id);
    res.json({ ok: true });
  });

  // ---------- state ----------

  app.get('/api/lichess', async (req, res) => {
    const account = await refreshAccount(req.user.id);
    if (!account) return res.json({ connected: false });
    const sess = session(req.user.id);
    clearTimeout(sess.idleTimer);
    await ensureEvents(sess);
    const games = [...sess.games.values()].filter((g) => !g.finished && g.full).map((g) => snapshot(sess, g));
    res.json({
      connected: true,
      username: account.username,
      url: `${host}/@/${account.username}`,
      ratings: ratings(account),
      shareInClub: !!account.share_in_club,
      seeking: sess.seek ? { time: sess.seek.time, increment: sess.seek.increment, rated: sess.seek.rated, since: sess.seek.since } : null,
      outgoing: sess.outgoing ? { username: sess.outgoing.username, since: sess.outgoing.since } : null,
      challenges: [...sess.challenges.values()].map((c) => ({
        id: c.id, from: c.challenger?.name, rating: c.challenger?.rating ?? null, rated: !!c.rated,
        speed: c.speed, timeControl: c.timeControl?.show || null, color: c.color, url: c.url,
      })),
      games,
    });
  });

  // ---------- starting games ----------

  function readClock(body, kind) {
    const clock = { limit: Math.round(Number(body.limit)), increment: Math.round(Number(body.increment)) };
    const problem = clockProblem(clock, kind);
    if (problem) throw new HttpError(400, problem);
    return clock;
  }

  /**
   * Start a long-lived streamed request (seek, challenge). Waits briefly for Lichess to accept or refuse
   * it; if it is still open after that, it is treated as accepted and keeps running in the background.
   * Returns the response, or null if it is still pending (then `onResponse` gets it later).
   */
  async function startStream(promise, onResponse) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('pending'), 4000));
    let res;
    try {
      res = await Promise.race([promise, timeout]);
    } catch {
      throw new HttpError(502, "Couldn't reach Lichess");
    }
    if (res === 'pending') {
      promise.then(onResponse, () => onResponse(null));
      return null;
    }
    return res;
  }

  /** Hold a streamed Lichess request open in the background; `onLine` sees each line; resolves when it ends. */
  async function holdStream(res, onLine) {
    try {
      for await (const line of ndjson(res)) onLine(line);
    } catch {
      // closed
    }
  }

  // A seek stays active only while its request is open; Lichess closes it once paired or expired.
  app.post('/api/lichess/seek', async (req, res) => {
    const sess = requireSession(req);
    if (sess.seek || sess.outgoing) throw new HttpError(409, 'You are already waiting for a Lichess game');
    const clock = readClock(req.body || {}, 'seek');
    const rated = req.body?.rated === true;
    await ensureEvents(sess);
    const ac = new AbortController();
    const seek = { ac, time: clock.limit / 60, increment: clock.increment, rated, since: Date.now() };
    const ended = () => {
      if (sess.seek === seek) sess.seek = null;
      emit(req.user.id, 'lichess:changed', {});
    };
    const follow = async (upstream) => {
      if (!upstream?.ok) {
        if (upstream && sess.seek === seek) emit(req.user.id, 'lichess:notice', { message: (await lichessError(upstream, req.user.id)).message });
        return ended();
      }
      holdStream(upstream, () => {}).then(ended);
    };
    const upstream = await startStream(call(sess.account.token, '/api/board/seek', {
      method: 'POST', signal: ac.signal,
      form: { rated, time: clock.limit / 60, increment: clock.increment, variant: 'standard' },
    }), follow);
    if (upstream && !upstream.ok) throw await lichessError(upstream, req.user.id);
    sess.seek = seek;
    emit(req.user.id, 'lichess:changed', {});
    res.status(202).json({ seeking: true });
    if (upstream) follow(upstream);
  });

  app.post('/api/lichess/seek/cancel', (req, res) => {
    const sess = requireSession(req);
    sess.seek?.ac.abort();
    sess.seek = null;
    emit(req.user.id, 'lichess:changed', {});
    res.json({ ok: true });
  });

  // Challenge a Lichess user. keepAliveStream keeps the challenge open (otherwise it expires in 20 s).
  app.post('/api/lichess/challenge', async (req, res) => {
    const sess = requireSession(req);
    if (sess.seek || sess.outgoing) throw new HttpError(409, 'You are already waiting for a Lichess game');
    const username = String(req.body?.username || '').trim();
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) throw new HttpError(400, 'Enter a Lichess username');
    const clock = readClock(req.body || {}, 'challenge');
    const color = ['white', 'black'].includes(req.body?.color) ? req.body.color : 'random';
    await ensureEvents(sess);
    const ac = new AbortController();
    const out = { ac, id: null, username, since: Date.now() };
    const ended = () => {
      if (sess.outgoing === out) sess.outgoing = null;
      emit(req.user.id, 'lichess:changed', {});
    };
    const follow = async (upstream) => {
      if (!upstream?.ok) {
        if (upstream && sess.outgoing === out) emit(req.user.id, 'lichess:notice', { message: (await lichessError(upstream, req.user.id)).message });
        return ended();
      }
      holdStream(upstream, (line) => {
        if (line.id && !out.id) out.id = line.id;
        if (line.challenge?.id && !out.id) out.id = line.challenge.id;
        if (line.done && line.done !== 'accepted') {
          emit(req.user.id, 'lichess:notice', { message: line.done === 'declined' ? `${username} declined the challenge` : `The challenge to ${username} ended` });
        }
      }).then(ended);
    };
    const upstream = await startStream(call(sess.account.token, `/api/challenge/${encodeURIComponent(username)}`, {
      method: 'POST', signal: ac.signal,
      form: { rated: req.body?.rated === true, 'clock.limit': clock.limit, 'clock.increment': clock.increment, color, variant: 'standard', keepAliveStream: true },
    }), follow);
    if (upstream && !upstream.ok) throw await lichessError(upstream, req.user.id);
    sess.outgoing = out;
    emit(req.user.id, 'lichess:changed', {});
    res.status(202).json({ challenging: username });
    if (upstream) follow(upstream);
  });

  app.post('/api/lichess/challenge/cancel', async (req, res) => {
    const sess = requireSession(req);
    const out = sess.outgoing;
    if (out?.id) await call(sess.account.token, `/api/challenge/${encodeURIComponent(out.id)}/cancel`, { method: 'POST' }).catch(() => {});
    out?.ac.abort();
    sess.outgoing = null;
    emit(req.user.id, 'lichess:changed', {});
    res.json({ ok: true });
  });

  app.post('/api/lichess/challenges/:id/:action', async (req, res) => {
    const sess = requireSession(req);
    const { id, action } = req.params;
    if (!['accept', 'decline'].includes(action) || !sess.challenges.has(id)) throw new HttpError(404, 'Challenge not found');
    await ensureEvents(sess);
    await callJson(sess.account.token, `/api/challenge/${encodeURIComponent(id)}/${action}`, { method: 'POST' }, req.user.id);
    sess.challenges.delete(id);
    emit(req.user.id, 'lichess:changed', {});
    res.json({ ok: true });
  });

  app.post('/api/lichess/ai', async (req, res) => {
    const sess = requireSession(req);
    const level = Math.round(Number(req.body?.level));
    if (!(level >= 1 && level <= 8)) throw new HttpError(400, 'Choose a level from 1 to 8');
    const clock = readClock(req.body || {}, 'ai');
    const color = ['white', 'black'].includes(req.body?.color) ? req.body.color : 'random';
    await ensureEvents(sess);
    const game = await callJson(sess.account.token, '/api/challenge/ai', {
      method: 'POST', form: { level, 'clock.limit': clock.limit, 'clock.increment': clock.increment, color, variant: 'standard' },
    }, req.user.id);
    if (game.id) watchGame(sess, game.id);
    res.status(201).json({ gameId: game.id });
  });

  // ---------- playing ----------

  app.post('/api/lichess/sharing', (req, res) => {
    const share = req.body?.share !== false;
    s.setShare.run(share ? 1 : 0, req.user.id);
    const sess = sessions.get(req.user.id);
    if (sess) sess.account.share_in_club = share ? 1 : 0;
    for (const { club_id: clubId } of s.clubsOf.all(req.user.id)) io.to(`club:${clubId}`).emit('club:changed', { clubId });
    res.json({ shareInClub: share });
  });

  // Your own game, or a clubmate's live game you're watching (no Lichess account needed to watch).
  app.get('/api/lichess/games/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9]{8,12}$/.test(id)) throw new HttpError(404, 'Game not found');
    const own = session(req.user.id);
    if (own?.games.has(id)) {
      await ensureEvents(own);
      const g = watchGame(own, id);
      return res.json({ game: g.error ? { id, error: g.error } : snapshot(own, g) });
    }
    const shared = sharedGame(req.user.id, id);
    if (shared) return res.json({ game: spectatorSnapshot(shared.sess, shared.g) });
    if (!own) throw new HttpError(404, "This Lichess game isn't being shared with your club");
    clearTimeout(own.idleTimer);
    await ensureEvents(own);
    const g = watchGame(own, id);
    res.json({ game: g.error ? { id, error: g.error } : snapshot(own, g) });
  });

  const ACTIONS = { resign: 'resign', abort: 'abort', 'draw-offer': 'draw/yes', 'draw-accept': 'draw/yes', 'draw-decline': 'draw/no', 'claim-victory': 'claim-victory' };
  app.post('/api/lichess/games/:id/:action', async (req, res) => {
    const sess = requireSession(req);
    const id = String(req.params.id);
    const { action } = req.params;
    if (!/^[A-Za-z0-9]{8,12}$/.test(id)) throw new HttpError(404, 'Game not found');
    let path;
    if (action === 'move') {
      const uci = String(req.body?.uci || '');
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new HttpError(400, 'Invalid move');
      path = `/api/board/game/${id}/move/${uci}`;
    } else if (ACTIONS[action]) {
      path = `/api/board/game/${id}/${ACTIONS[action]}`;
    } else {
      throw new HttpError(404, 'Unknown action');
    }
    await callJson(sess.account.token, path, { method: 'POST' }, req.user.id);
    res.json({ ok: true });
  });

  // ---------- sockets ----------

  io.on('connection', (socket) => {
    const userId = socket.data.user.id;
    const sess = session(userId);
    if (sess) {
      clearTimeout(sess.idleTimer);
      ensureEvents(sess);
    }
    // Only the player, or clubmates of a member who shares the game, may follow it.
    socket.on('watch:lichess', (id) => {
      const gameId = String(id);
      if (sessions.get(userId)?.games.has(gameId) || sharedGame(userId, gameId)) socket.join(`lichess:${gameId}`);
    });
    socket.on('unwatch:lichess', (id) => socket.leave(`lichess:${String(id)}`));
    socket.on('disconnect', () => {
      const current = sessions.get(userId);
      if (current) scheduleIdleCheck(current);
    });
  });

  return {
    /** Linked Lichess account for a profile: {username, url, ratings} or null. */
    /** Live Lichess games of the club's members who share them, shaped like club games. */
    clubLiveGames(clubId) {
      const name = s.clubName.get(clubId)?.name;
      const out = [];
      for (const sess of sessions.values()) {
        if (!sharing(sess) || !s.isMember.get(clubId, sess.userId)) continue;
        for (const g of sess.games.values()) {
          if (g.finished || !g.full) continue;
          const shaped = clubShape(sess, g, name);
          if (shaped.fen) out.push(shaped); // skip a game whose moves couldn't be read rather than break the page
        }
      }
      return out;
    },
    profileInfo(userId) {
      const account = s.account.get(userId);
      return account ? { username: account.username, url: `${host}/@/${account.username}`, ratings: ratings(account), shareInClub: !!account.share_in_club } : null;
    },
    close() {
      for (const sess of [...sessions.values()]) closeSession(sess);
    },
  };
}
