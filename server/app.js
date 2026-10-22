import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openDb } from './db.js';
import { createAuth } from './auth.js';
import { registerPublicAccountRoutes, registerAccountRoutes } from './account.js';
import { createMaintenance } from './maintenance.js';
import { registerClubAdminRoutes } from './clubadmin.js';
import { createRatings } from './ratings.js';
import { registerProfileRoutes } from './profiles.js';
import { registerTournamentRoutes } from './tournaments.js';
import { summarizeReview } from './review-summary.js';
import { START_FEN, replay, gameOverInfo, tryMove, isValidFen } from './chesslogic.js';
import {
  TIMED_MODES, parseTimeControl, clampMs, getTimeControl, remainingTime, clockFields, timeoutResult,
} from './clock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BROADCAST_MODES = new Set(['computer', 'self', 'otb']);
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function makeInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function createServer({ dbFile = path.join(ROOT, 'data', 'chessclub.db'), rateLimits = true } = {}) {
  const db = openDb(dbFile);
  const auth = createAuth(db);
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server);

  app.disable('x-powered-by');
  // Behind nginx (or another reverse proxy on the local network): trust its X-Forwarded-* headers so
  // req.ip is the player's address (for login limits) and req.secure reflects HTTPS (for secure cookies).
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
  app.use(express.json({ limit: '200kb' }));
  app.use(auth.attachUser);
  // Browsers must check for new app files on every load (cheap 304s via ETag), so updates reach phones at once.
  app.use(express.static(path.join(ROOT, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.get('/vendor/chess.js', (_req, res) => {
    res.sendFile(path.join(ROOT, 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js'));
  });
  // Stockfish (GPL-3.0, unmodified build from the "stockfish" npm package) runs in the browser.
  const STOCKFISH_FILES = new Set(['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']);
  app.get('/vendor/stockfish/:file', (req, res, next) => {
    if (req.params.file === 'COPYING.txt') return res.sendFile(path.join(ROOT, 'node_modules', 'stockfish', 'Copying.txt'));
    if (!STOCKFISH_FILES.has(req.params.file)) return next();
    res.sendFile(path.join(ROOT, 'node_modules', 'stockfish', 'bin', req.params.file), { maxAge: '7d' });
  });

  // ---------- data helpers ----------

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'),
    club: db.prepare('SELECT * FROM clubs WHERE id = ?'),
    clubByCode: db.prepare('SELECT * FROM clubs WHERE invite_code = ?'),
    membership: db.prepare('SELECT * FROM memberships WHERE club_id = ? AND user_id = ?'),
    addMember: db.prepare('INSERT OR IGNORE INTO memberships (club_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'),
    removeMember: db.prepare('DELETE FROM memberships WHERE club_id = ? AND user_id = ?'),
    insertClub: db.prepare(`INSERT INTO clubs (name, description, owner_id, is_public, invite_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    myClubs: db.prepare(`
      SELECT c.*, m.role,
        (SELECT COUNT(*) FROM memberships WHERE club_id = c.id) AS member_count,
        (SELECT COUNT(*) FROM games g WHERE g.club_id = c.id AND g.status = 'active' AND g.visibility = 'club') AS active_games
      FROM clubs c JOIN memberships m ON m.club_id = c.id AND m.user_id = ?
      ORDER BY c.name COLLATE NOCASE`),
    publicClubs: db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM memberships WHERE club_id = c.id) AS member_count
      FROM clubs c
      WHERE c.is_public = 1 AND c.id NOT IN (SELECT club_id FROM memberships WHERE user_id = ?)
      ORDER BY member_count DESC, c.name COLLATE NOCASE LIMIT 100`),
    members: db.prepare(`
      SELECT u.id, u.username, m.role, m.joined_at FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.club_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.username COLLATE NOCASE`),
    game: db.prepare('SELECT g.*, c.name AS club_name FROM games g JOIN clubs c ON c.id = g.club_id WHERE g.id = ?'),
    clubGames: db.prepare(`
      SELECT g.*, c.name AS club_name FROM games g JOIN clubs c ON c.id = g.club_id
      WHERE g.club_id = ? AND g.status = ? ORDER BY g.updated_at DESC LIMIT ?`),
    myGames: db.prepare(`
      SELECT g.*, c.name AS club_name FROM games g JOIN clubs c ON c.id = g.club_id
      WHERE g.status IN ('active', 'waiting')
        AND (g.white_id = ? OR g.black_id = ? OR g.created_by = ? OR g.invited_id = ?)
        AND g.club_id IN (SELECT club_id FROM memberships WHERE user_id = ?)
      ORDER BY g.updated_at DESC LIMIT 100`),
    userName: db.prepare('SELECT username FROM users WHERE id = ?'),
    insertGame: db.prepare(`
      INSERT INTO games (club_id, mode, visibility, status, created_by, white_id, black_id, white_name, black_name,
        creator_color, invited_id, start_fen, fen, moves, result, termination, meta, created_at, updated_at,
        time_control, white_ms, black_ms, turn_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    activeTimedGames: db.prepare("SELECT * FROM games WHERE status = 'active' AND turn_started_at IS NOT NULL"),
  };

  const ratings = createRatings(db);
  // Features that react to a game finishing (tournaments) register here; called on every notify of a
  // finished game, so hooks must be idempotent.
  const gameFinishedHooks = [];
  const onGameFinished = (fn) => gameFinishedHooks.push(fn);

  /** Rate a finished online game once (both players moved, still members, not a casual game). */
  function applyRatingIfDue(g) {
    if (g.mode !== 'online' || g.status !== 'finished' || !RESULTS.has(g.result)) return;
    const meta = JSON.parse(g.meta);
    if (meta.rated === false || meta.ratings || JSON.parse(g.moves).length < 2) return;
    meta.ratings = ratings.rateResult({ clubId: g.club_id, whiteId: g.white_id, blackId: g.black_id, result: g.result, gameId: g.id })
      || { skipped: true };
    db.prepare('UPDATE games SET meta = ? WHERE id = ?').run(JSON.stringify(meta), g.id);
  }

  function updateGame(id, fields) {
    const keys = Object.keys(fields);
    const sql = `UPDATE games SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    db.prepare(sql).run(...keys.map((k) => fields[k]), Date.now(), id);
  }

  function serializeGame(g) {
    return {
      id: g.id,
      clubId: g.club_id,
      clubName: g.club_name,
      mode: g.mode,
      visibility: g.visibility,
      status: g.status,
      createdBy: g.created_by,
      creatorName: q.userName.get(g.created_by)?.username,
      creatorColor: g.creator_color,
      invitedId: g.invited_id,
      invitedName: g.invited_id ? q.userName.get(g.invited_id)?.username : null,
      white: { id: g.white_id, name: g.white_name, rating: g.mode === 'online' && g.white_id ? ratings.ratingOf(g.club_id, g.white_id)?.rating ?? null : null },
      black: { id: g.black_id, name: g.black_name, rating: g.mode === 'online' && g.black_id ? ratings.ratingOf(g.club_id, g.black_id)?.rating ?? null : null },
      startFen: g.start_fen,
      fen: g.fen,
      turn: g.fen.split(' ')[1],
      moves: JSON.parse(g.moves),
      result: g.result,
      termination: g.termination,
      drawOfferBy: g.draw_offer_by,
      meta: JSON.parse(g.meta),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      timeControl: timeControlForClient(g),
      hasAnalysis: !!g.analysis,
      // Remaining time right now; clients count down from when they receive it.
      clock: g.time_control ? (({ running, w, b }) => ({ white: w, black: b, running }))(remainingTime(g)) : null,
    };
  }

  function timeControlForClient(g) {
    const tc = getTimeControl(g);
    return tc ? { initial: tc.initial / 1000, increment: tc.increment / 1000 } : null;
  }

  /** Eval bar settings from a create request: {evalBar, evalBarMoves?} (a move limit of 1-200), or {}. */
  function evalBarMeta(body) {
    if (body.evalBar !== true) return {};
    const n = Math.round(Number(body.evalBarMoves));
    return n >= 1 && n <= 200 ? { evalBar: true, evalBarMoves: n } : { evalBar: true };
  }

  function readTimeControl(body, mode) {
    if (!TIMED_MODES.has(mode)) return null;
    try {
      return parseTimeControl(body.timeControl);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  /** Update a game that changed state, settling the clocks at the same moment. */
  function updateGameWithClock(g, fields, { moved = false } = {}) {
    const status = fields.status ?? g.status;
    const plies = fields.moves ? JSON.parse(fields.moves).length : JSON.parse(g.moves).length;
    updateGame(g.id, { ...clockFields(g, { moved, status, plies }), ...fields });
  }

  // ---------- server-side flag detection ----------

  const flagTimers = new Map();

  /** Arrange for the game to be ended on time even if nobody makes another request. */
  function scheduleFlag(g) {
    clearTimeout(flagTimers.get(g.id));
    flagTimers.delete(g.id);
    if (g.status !== 'active' || !g.time_control || !g.turn_started_at) return;
    const { running, w, b } = remainingTime(g);
    const timer = setTimeout(() => {
      flagTimers.delete(g.id);
      checkFlag(g.id);
    }, (running === 'w' ? w : b) + 25);
    timer.unref?.();
    flagTimers.set(g.id, timer);
  }

  /** End the game if the side to move has run out of time. Returns true if it did. */
  function checkFlag(gameId) {
    const g = q.game.get(gameId);
    if (!g || g.status !== 'active' || !g.time_control || !g.turn_started_at) return false;
    const { running, w, b } = remainingTime(g);
    if ((running === 'w' ? w : b) > 0) {
      scheduleFlag(g);
      return false;
    }
    const { result, termination } = timeoutResult(g.fen, running);
    updateGame(g.id, {
      status: 'finished', result, termination, draw_offer_by: null,
      white_ms: running === 'w' ? 0 : w, black_ms: running === 'b' ? 0 : b, turn_started_at: null,
    });
    notify(g.id);
    return true;
  }

  for (const g of q.activeTimedGames.all()) {
    if (!checkFlag(g.id)) scheduleFlag(g);
  }
  server.on('close', () => {
    for (const timer of flagTimers.values()) clearTimeout(timer);
    flagTimers.clear();
  });

  /** Accept only the expected shape for a stored game analysis (see public/js/review.js). */
  function validateAnalysis(input, moveCount) {
    const positions = input?.positions;
    if (!Array.isArray(positions) || positions.length !== moveCount + 1) throw new HttpError(400, 'Analysis does not match the game');
    const num = (v) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const uci = (v) => (typeof v === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(v) ? v : null);
    return {
      engine: cleanText(input.engine, 60),
      timeMs: num(input.timeMs),
      positions: positions.map((p) => ({
        best: uci(p?.best), cp: num(p?.cp), mate: num(p?.mate),
        alt: uci(p?.alt), cp2: num(p?.cp2), mate2: num(p?.mate2),
      })),
    };
  }

  function isParticipant(user, g) {
    return [g.white_id, g.black_id, g.created_by, g.invited_id].includes(user.id);
  }

  function canView(user, g) {
    if (!user || !q.membership.get(g.club_id, user.id)) return false;
    return g.visibility === 'club' || isParticipant(user, g);
  }

  function loadClubForMember(req) {
    const club = q.club.get(Number(req.params.id));
    if (!club) throw new HttpError(404, 'Club not found');
    const membership = q.membership.get(club.id, req.user.id);
    return { club, membership };
  }

  function requireMember(req) {
    const result = loadClubForMember(req);
    if (!result.membership) throw new HttpError(403, 'You are not a member of this club');
    return result;
  }

  function loadGame(req) {
    const g = q.game.get(Number(req.params.id));
    if (!g || !canView(req.user, g)) throw new HttpError(404, 'Game not found');
    return g;
  }

  function notify(gameId) {
    let g = q.game.get(gameId);
    if (!g) return;
    if (g.status === 'finished') {
      applyRatingIfDue(g);
      g = q.game.get(gameId);
      for (const hook of gameFinishedHooks) hook(g);
    }
    scheduleFlag(g);
    const state = serializeGame(g);
    io.to(`game:${g.id}`).emit('game', state);
    io.to(`club:${g.club_id}`).emit('club:changed', { clubId: g.club_id });
    for (const uid of new Set([g.white_id, g.black_id, g.created_by, g.invited_id])) {
      if (uid) io.to(`user:${uid}`).emit('mygames:changed');
    }
    return state;
  }

  /** Validate and apply a move for the given user. Returns the updated serialized game. */
  function applyMove(user, g, move) {
    if (g.status !== 'active') throw new HttpError(409, 'Game is not active');
    const turn = g.fen.split(' ')[1];
    if (g.mode === 'online') {
      const mover = turn === 'w' ? g.white_id : g.black_id;
      if (mover !== user.id) throw new HttpError(403, 'It is not your turn');
    } else if (g.created_by !== user.id) {
      throw new HttpError(403, 'Only the broadcaster can move in this game');
    }
    // A move that arrives after the flag fell loses on time, whether or not the timer has fired yet.
    if (checkFlag(g.id)) throw new HttpError(409, 'Time is up');
    const moves = JSON.parse(g.moves);
    const chess = replay(g.start_fen, moves);
    const san = tryMove(chess, move);
    if (!san) throw new HttpError(400, 'Illegal move');
    moves.push(san);
    const fields = { fen: chess.fen(), moves: JSON.stringify(moves), draw_offer_by: null };
    const over = gameOverInfo(chess);
    if (over) Object.assign(fields, { status: 'finished', result: over.result, termination: over.termination });
    updateGameWithClock(g, fields, { moved: true });
    return notify(g.id);
  }

  // ---------- accounts ----------

  const ctx = { app, db, io, q, auth, HttpError, cleanText, rateLimits };
  registerPublicAccountRoutes(ctx);

  app.use('/api', auth.requireUser);
  Object.assign(ctx, { notify, makeInviteCode, ratings, serializeGame, canView, onGameFinished });
  registerProfileRoutes(ctx);
  registerTournamentRoutes(ctx);

  app.get('/api/clubs/:id/leaderboard', (req, res) => {
    const { club } = requireMember(req);
    res.json({ leaderboard: ratings.leaderboard(club.id) });
  });
  registerAccountRoutes(ctx);
  registerClubAdminRoutes(ctx);

  // ---------- clubs ----------

  app.get('/api/clubs', (req, res) => {
    const mine = q.myClubs.all(req.user.id).map((c) => ({
      id: c.id, name: c.name, description: c.description, role: c.role,
      isPublic: !!c.is_public, memberCount: c.member_count, activeGames: c.active_games,
    }));
    const discover = q.publicClubs.all(req.user.id).map((c) => ({
      id: c.id, name: c.name, description: c.description, memberCount: c.member_count,
    }));
    res.json({ mine, discover });
  });

  app.post('/api/clubs', (req, res) => {
    const name = cleanText(req.body?.name, 60);
    const description = cleanText(req.body?.description, 500);
    if (name.length < 2) throw new HttpError(400, 'Club name must be at least 2 characters');
    const isPublic = req.body?.isPublic === false ? 0 : 1;
    const now = Date.now();
    const { lastInsertRowid } = q.insertClub.run(name, description, req.user.id, isPublic, makeInviteCode(), now);
    const clubId = Number(lastInsertRowid);
    q.addMember.run(clubId, req.user.id, 'owner', now);
    res.status(201).json({ club: { id: clubId, name } });
  });

  app.post('/api/clubs/join-by-code', (req, res) => {
    const code = cleanText(req.body?.code, 20).toUpperCase();
    const club = q.clubByCode.get(code);
    if (!club) throw new HttpError(404, 'No club with that invite code');
    q.addMember.run(club.id, req.user.id, 'member', Date.now());
    io.to(`club:${club.id}`).emit('club:changed', { clubId: club.id });
    res.json({ club: { id: club.id, name: club.name } });
  });

  app.get('/api/clubs/:id', (req, res) => {
    const { club, membership } = loadClubForMember(req);
    if (!membership && !club.is_public) throw new HttpError(404, 'Club not found');
    res.json({
      club: {
        id: club.id,
        name: club.name,
        description: club.description,
        isPublic: !!club.is_public,
        ownerId: club.owner_id,
        inviteCode: membership ? club.invite_code : undefined,
      },
      membership: membership ? { role: membership.role } : null,
      members: membership ? q.members.all(club.id) : [],
    });
  });

  app.post('/api/clubs/:id/join', (req, res) => {
    const { club, membership } = loadClubForMember(req);
    if (!membership) {
      const code = cleanText(req.body?.code, 20).toUpperCase();
      if (!club.is_public && code !== club.invite_code) throw new HttpError(403, 'This club requires an invite code');
      q.addMember.run(club.id, req.user.id, 'member', Date.now());
      io.to(`club:${club.id}`).emit('club:changed', { clubId: club.id });
    }
    res.json({ ok: true });
  });

  app.post('/api/clubs/:id/leave', (req, res) => {
    const { club, membership } = requireMember(req);
    if (membership.role === 'owner') throw new HttpError(400, 'The club owner cannot leave the club');
    q.removeMember.run(club.id, req.user.id);
    io.to(`club:${club.id}`).emit('club:changed', { clubId: club.id });
    res.json({ ok: true });
  });

  app.get('/api/clubs/:id/games', (req, res) => {
    const { club } = requireMember(req);
    const visible = (rows) => rows.filter((g) => canView(req.user, g)).map(serializeGame);
    res.json({
      active: visible(q.clubGames.all(club.id, 'active', 200)),
      waiting: visible(q.clubGames.all(club.id, 'waiting', 100)),
      finished: visible(q.clubGames.all(club.id, 'finished', 30)),
    });
  });

  app.post('/api/clubs/:id/games', (req, res) => {
    const { club } = requireMember(req);
    const body = req.body || {};
    const mode = body.mode;
    const now = Date.now();
    const me = req.user;

    if (mode === 'online') {
      const color = ['white', 'black', 'random'].includes(body.color) ? body.color : 'random';
      const visibility = body.visibility === 'private' ? 'private' : 'club';
      let invitedId = null;
      if (body.opponentId != null) {
        invitedId = Number(body.opponentId);
        if (invitedId === me.id) throw new HttpError(400, 'You cannot challenge yourself');
        if (!q.membership.get(club.id, invitedId)) throw new HttpError(400, 'Opponent is not a club member');
      }
      const tc = readTimeControl(body, 'online');
      const { lastInsertRowid } = q.insertGame.run(
        club.id, 'online', visibility, 'waiting', me.id,
        color === 'white' ? me.id : null, color === 'black' ? me.id : null,
        color === 'white' ? me.username : null, color === 'black' ? me.username : null,
        color, invitedId, START_FEN, START_FEN, '[]', '*', null, JSON.stringify({ ...evalBarMeta(body), rated: body.rated !== false }), now, now,
        tc ? JSON.stringify(tc) : null, tc?.initial ?? null, tc?.initial ?? null, null,
      );
      const state = notify(Number(lastInsertRowid));
      return res.status(201).json({ game: state });
    }

    if (BROADCAST_MODES.has(mode)) {
      const startFen = body.startFen || START_FEN;
      if (!isValidFen(startFen)) throw new HttpError(400, 'Invalid starting position');
      const moves = Array.isArray(body.moves) ? body.moves : [];
      let chess;
      try {
        chess = replay(startFen, moves);
      } catch {
        throw new HttpError(400, 'Move list contains an illegal move');
      }
      const sanMoves = chess.history();
      const whiteName = cleanText(body.whiteName, 40) || (mode === 'otb' ? 'White' : me.username);
      const blackName = cleanText(body.blackName, 40) || (mode === 'otb' ? 'Black' : me.username);
      const meta = {};
      if (mode === 'computer') {
        meta.playerColor = body.playerColor === 'black' ? 'black' : 'white';
        if (body.elo != null) {
          meta.elo = Math.min(3190, Math.max(400, Math.round(Number(body.elo)) || 1500));
          if (body.bot) meta.bot = cleanText(body.bot, 30);
        } else {
          meta.level = Math.min(5, Math.max(1, Number(body.level) || 3));
        }
      }
      if (body.localId) meta.localId = cleanText(body.localId, 64);
      if (mode === 'otb') meta.event = cleanText(body.event, 80);
      Object.assign(meta, evalBarMeta(body));
      const over = gameOverInfo(chess);
      // The broadcaster's device has been timing the game so far; continue from its clock readings.
      const tc = readTimeControl(body, mode);
      const clockStarts = tc && !over && sanMoves.length >= 2;
      const { lastInsertRowid } = q.insertGame.run(
        club.id, mode, 'club', over ? 'finished' : 'active', me.id,
        null, null, whiteName, blackName, null, null,
        startFen, chess.fen(), JSON.stringify(sanMoves),
        over ? over.result : '*', over ? over.termination : null, JSON.stringify(meta), now, now,
        tc ? JSON.stringify(tc) : null,
        tc ? clampMs(body.whiteMs, tc.initial) : null, tc ? clampMs(body.blackMs, tc.initial) : null,
        clockStarts ? now : null,
      );
      const state = notify(Number(lastInsertRowid));
      return res.status(201).json({ game: state });
    }

    throw new HttpError(400, 'Unknown game mode');
  });

  // ---------- games ----------

  app.get('/api/my/games', (req, res) => {
    const id = req.user.id;
    res.json({ games: q.myGames.all(id, id, id, id, id).map(serializeGame) });
  });

  app.get('/api/games/:id', (req, res) => {
    res.json({ game: serializeGame(loadGame(req)) });
  });

  app.post('/api/games/:id/accept', (req, res) => {
    const g = loadGame(req);
    const me = req.user;
    if (g.mode !== 'online' || g.status !== 'waiting') throw new HttpError(409, 'This challenge is no longer open');
    if (g.created_by === me.id) throw new HttpError(400, 'You cannot accept your own challenge');
    if (g.invited_id && g.invited_id !== me.id) throw new HttpError(403, 'This challenge is for another player');
    const creatorName = q.userName.get(g.created_by).username;
    let creatorWhite = g.creator_color === 'white';
    if (g.creator_color === 'random') creatorWhite = crypto.randomInt(2) === 0;
    const fields = creatorWhite
      ? { white_id: g.created_by, white_name: creatorName, black_id: me.id, black_name: me.username }
      : { white_id: me.id, white_name: me.username, black_id: g.created_by, black_name: creatorName };
    // Guard against two players accepting at the same moment.
    const changed = db.prepare(`UPDATE games SET status = 'active', white_id = ?, white_name = ?, black_id = ?,
      black_name = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
      .run(fields.white_id, fields.white_name, fields.black_id, fields.black_name, Date.now(), g.id);
    const tc = getTimeControl(g);
    if (tc) updateGame(g.id, { white_ms: tc.initial, black_ms: tc.initial, turn_started_at: null });
    if (changed.changes === 0) throw new HttpError(409, 'This challenge is no longer open');
    res.json({ game: notify(g.id) });
  });

  app.post('/api/games/:id/cancel', (req, res) => {
    const g = loadGame(req);
    const me = req.user;
    if (g.status === 'waiting') {
      if (g.created_by !== me.id && g.invited_id !== me.id) throw new HttpError(403, 'Not your challenge');
      updateGame(g.id, { status: 'aborted', termination: g.created_by === me.id ? 'cancelled' : 'declined' });
    } else if (g.status === 'active' && BROADCAST_MODES.has(g.mode)) {
      // Stopping a broadcast pauses it: the game continues privately on the broadcaster's device and
      // can be resumed under the same id, so spectators already watching pick it up again.
      if (g.created_by !== me.id) throw new HttpError(403, 'Only the broadcaster can stop this broadcast');
      updateGameWithClock(g, { status: 'paused', draw_offer_by: null });
    } else if (g.status === 'active' && g.mode === 'online' && JSON.parse(g.meta).tournament) {
      throw new HttpError(409, "Tournament games can't be aborted — ask the organiser");
    } else if (g.status === 'active' && g.mode === 'online' && JSON.parse(g.moves).length < 2) {
      if (g.white_id !== me.id && g.black_id !== me.id) throw new HttpError(403, 'Not your game');
      updateGameWithClock(g, { status: 'aborted', termination: 'aborted' });
    } else {
      throw new HttpError(409, 'This game cannot be cancelled');
    }
    res.json({ game: notify(g.id) });
  });

  app.post('/api/games/:id/move', (req, res) => {
    const g = loadGame(req);
    const body = req.body || {};
    const move = typeof body.san === 'string' ? body.san : { from: body.from, to: body.to, promotion: body.promotion };
    res.json({ game: applyMove(req.user, g, move) });
  });

  app.post('/api/games/:id/resign', (req, res) => {
    const g = loadGame(req);
    const me = req.user;
    if (g.status !== 'active') throw new HttpError(409, 'Game is not active');
    let loser;
    if (g.mode === 'online') {
      if (me.id === g.white_id) loser = 'w';
      else if (me.id === g.black_id) loser = 'b';
      else throw new HttpError(403, 'You are not playing in this game');
    } else if (g.mode === 'computer' && g.created_by === me.id) {
      loser = JSON.parse(g.meta).playerColor === 'black' ? 'b' : 'w';
    } else {
      throw new HttpError(400, 'Use the result endpoint for this game');
    }
    if (checkFlag(g.id)) throw new HttpError(409, 'Time is up');
    updateGameWithClock(g, {
      status: 'finished',
      result: loser === 'w' ? '0-1' : '1-0',
      termination: `${loser === 'w' ? 'white' : 'black'} resigned`,
      draw_offer_by: null,
    });
    res.json({ game: notify(g.id) });
  });

  app.post('/api/games/:id/draw', (req, res) => {
    const g = loadGame(req);
    const me = req.user;
    if (g.mode !== 'online' || g.status !== 'active') throw new HttpError(409, 'Draw offers are only for active online games');
    if (me.id !== g.white_id && me.id !== g.black_id) throw new HttpError(403, 'You are not playing in this game');
    const action = req.body?.action;
    if (action === 'offer') {
      if (g.draw_offer_by && g.draw_offer_by !== me.id) {
        updateGameWithClock(g, { status: 'finished', result: '1/2-1/2', termination: 'draw agreed', draw_offer_by: null });
      } else {
        updateGame(g.id, { draw_offer_by: me.id });
      }
    } else if (action === 'accept') {
      if (!g.draw_offer_by || g.draw_offer_by === me.id) throw new HttpError(409, 'There is no draw offer to accept');
      if (checkFlag(g.id)) throw new HttpError(409, 'Time is up');
      updateGameWithClock(g, { status: 'finished', result: '1/2-1/2', termination: 'draw agreed', draw_offer_by: null });
    } else if (action === 'decline') {
      if (!g.draw_offer_by || g.draw_offer_by === me.id) throw new HttpError(409, 'There is no draw offer to decline');
      updateGame(g.id, { draw_offer_by: null });
    } else {
      throw new HttpError(400, 'Unknown draw action');
    }
    res.json({ game: notify(g.id) });
  });

  // Broadcaster-only: declare the result of a broadcast game (e.g. a real over-the-board game).
  app.post('/api/games/:id/result', (req, res) => {
    const g = loadGame(req);
    if (!BROADCAST_MODES.has(g.mode)) throw new HttpError(400, 'Online games end by play, resignation or agreement');
    if (g.created_by !== req.user.id) throw new HttpError(403, 'Only the broadcaster can set the result');
    if (g.status !== 'active') throw new HttpError(409, 'Game is not active');
    const result = req.body?.result;
    if (!RESULTS.has(result)) throw new HttpError(400, 'Result must be 1-0, 0-1 or 1/2-1/2');
    updateGameWithClock(g, { status: 'finished', result, termination: cleanText(req.body?.termination, 60) || 'result declared' });
    res.json({ game: notify(g.id) });
  });

  // Game review: the engine analysis is computed in a viewer's browser and stored so everyone sees the same review.
  app.get('/api/games/:id/analysis', (req, res) => {
    const g = loadGame(req);
    res.json({ analysis: g.analysis ? JSON.parse(g.analysis) : null });
  });

  app.post('/api/games/:id/analysis', (req, res) => {
    const g = loadGame(req);
    if (g.status !== 'finished') throw new HttpError(409, 'Only finished games can be reviewed');
    // The first analysis stored wins; players in the game may replace it.
    if (g.analysis && !isParticipant(req.user, g)) return res.json({ analysis: JSON.parse(g.analysis) });
    const analysis = validateAnalysis(req.body?.analysis, JSON.parse(g.moves).length);
    // Accuracy is worked out here from the evaluations, not taken from the browser.
    analysis.summary = summarizeReview(g, analysis);
    updateGame(g.id, { analysis: JSON.stringify(analysis) });
    res.json({ analysis });
  });

  // Broadcaster-only: resume a paused broadcast with the moves played privately in the meantime.
  app.post('/api/games/:id/resume', (req, res) => {
    const g = loadGame(req);
    if (!BROADCAST_MODES.has(g.mode)) throw new HttpError(400, 'Only broadcast games can be resumed');
    if (g.created_by !== req.user.id) throw new HttpError(403, 'Only the broadcaster can resume this broadcast');
    if (g.status !== 'paused') throw new HttpError(409, 'This broadcast is not paused');
    const moves = Array.isArray(req.body?.moves) ? req.body.moves : JSON.parse(g.moves);
    let chess;
    try {
      chess = replay(g.start_fen, moves);
    } catch {
      throw new HttpError(400, 'Move list contains an illegal move');
    }
    const over = gameOverInfo(chess);
    const tc = getTimeControl(g);
    updateGame(g.id, {
      status: over ? 'finished' : 'active',
      moves: JSON.stringify(chess.history()),
      fen: chess.fen(),
      result: over ? over.result : '*',
      termination: over ? over.termination : null,
      // Continue from the broadcaster's clock readings after playing privately.
      ...(tc ? {
        white_ms: clampMs(req.body?.whiteMs, g.white_ms),
        black_ms: clampMs(req.body?.blackMs, g.black_ms),
        turn_started_at: !over && chess.history().length >= 2 ? Date.now() : null,
      } : {}),
    });
    res.json({ game: notify(g.id) });
  });

  // Broadcaster-only: take back moves (correcting an OTB entry, or a takeback against the computer).
  app.post('/api/games/:id/undo', (req, res) => {
    const g = loadGame(req);
    if (!BROADCAST_MODES.has(g.mode)) throw new HttpError(400, 'Takebacks are not available in online games');
    if (g.created_by !== req.user.id) throw new HttpError(403, 'Only the broadcaster can take back moves');
    if (g.status !== 'active') throw new HttpError(409, 'Game is not active');
    const count = Math.min(2, Math.max(1, Number(req.body?.count) || 1));
    const moves = JSON.parse(g.moves).slice(0, -count);
    const chess = replay(g.start_fen, moves);
    updateGameWithClock(g, { moves: JSON.stringify(moves), fen: chess.fen() });
    res.json({ game: notify(g.id) });
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ---------- realtime ----------

  io.use((socket, next) => {
    socket.data.user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
    if (!socket.data.user) return next(new Error('unauthorized'));
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    socket.on('watch:game', (id, ack) => {
      const g = q.game.get(Number(id));
      if (!g || !canView(user, g)) return ack?.({ error: 'Game not found' });
      socket.join(`game:${g.id}`);
      ack?.({ game: serializeGame(g) });
    });
    socket.on('unwatch:game', (id) => socket.leave(`game:${Number(id)}`));

    socket.on('watch:club', (id, ack) => {
      if (!q.membership.get(Number(id), user.id)) return ack?.({ error: 'Not a member' });
      socket.join(`club:${Number(id)}`);
      ack?.({ ok: true });
    });
    socket.on('unwatch:club', (id) => socket.leave(`club:${Number(id)}`));
  });

  const maintenance = createMaintenance({
    db,
    dbFile,
    notify,
    backupDir: process.env.BACKUP_DIR,
    keep: Number(process.env.BACKUP_KEEP) || 14,
    backups: process.env.BACKUPS !== '0',
  });
  maintenance.start();
  server.on('close', () => maintenance.stop());

  return { app, server, io, db, maintenance };
}
