// Club tournaments: registration, pairing rounds, results (from online games or reported over the
// board), automatic round advancing, standings.
import { START_FEN } from './chesslogic.js';
import { parseTimeControl } from './clock.js';
import { standings, roundRobin, swissRound } from './pairing.js';

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);

export function registerTournamentRoutes({ app, db, io, q, HttpError, cleanText, ratings, notify, onGameFinished }) {
  const s = {
    byClub: db.prepare("SELECT * FROM tournaments WHERE club_id = ? ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'registration' THEN 1 ELSE 2 END, updated_at DESC LIMIT 50"),
    get: db.prepare('SELECT * FROM tournaments WHERE id = ?'),
    insert: db.prepare(`INSERT INTO tournaments (club_id, name, format, play, rounds, time_control, rated, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare('UPDATE tournaments SET status = ?, current_round = ?, rounds = ?, schedule = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM tournaments WHERE id = ?'),
    players: db.prepare(`SELECT u.id, u.username, tp.withdrawn, COALESCE(m.rating, 1200) AS rating
      FROM tournament_players tp JOIN users u ON u.id = tp.user_id
      JOIN tournaments t ON t.id = tp.tournament_id
      LEFT JOIN memberships m ON m.club_id = t.club_id AND m.user_id = u.id
      WHERE tp.tournament_id = ? ORDER BY rating DESC, u.username COLLATE NOCASE`),
    addPlayer: db.prepare('INSERT INTO tournament_players (tournament_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET withdrawn = 0'),
    removePlayer: db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?'),
    withdraw: db.prepare('UPDATE tournament_players SET withdrawn = 1 WHERE tournament_id = ? AND user_id = ?'),
    pairings: db.prepare('SELECT * FROM tournament_pairings WHERE tournament_id = ? ORDER BY round, board'),
    pairing: db.prepare('SELECT * FROM tournament_pairings WHERE id = ? AND tournament_id = ?'),
    pairingByGame: db.prepare('SELECT * FROM tournament_pairings WHERE game_id = ?'),
    insertPairing: db.prepare(`INSERT INTO tournament_pairings (tournament_id, round, board, white_id, black_id, result)
      VALUES (?, ?, ?, ?, ?, ?)`),
    setResult: db.prepare('UPDATE tournament_pairings SET result = ?, reported_by = ? WHERE id = ?'),
    markRated: db.prepare('UPDATE tournament_pairings SET rated = 1 WHERE id = ?'),
    setGame: db.prepare('UPDATE tournament_pairings SET game_id = ? WHERE id = ?'),
    username: db.prepare('SELECT username FROM users WHERE id = ?'),
  };

  const changed = (t) => {
    io.to(`club:${t.club_id}`).emit('tournament:changed', { tournamentId: t.id, clubId: t.club_id });
    io.to(`club:${t.club_id}`).emit('club:changed', { clubId: t.club_id });
  };

  function load(req) {
    const t = s.get.get(Number(req.params.id));
    if (!t || !q.membership.get(t.club_id, req.user.id)) throw new HttpError(404, 'Tournament not found');
    return t;
  }

  /** The organiser is whoever created the tournament; the club owner can manage it too. */
  function canManage(user, t) {
    return t.created_by === user.id || q.membership.get(t.club_id, user.id)?.role === 'owner';
  }

  function requireManager(req, t) {
    if (!canManage(req.user, t)) throw new HttpError(403, 'Only the organiser or club owner can do that');
  }

  const toPairing = (p) => ({ round: p.round, white: p.white_id, black: p.black_id, result: p.result });

  function detail(t, user) {
    const players = s.players.all(t.id);
    const pairings = s.pairings.all(t.id);
    const names = new Map(players.map((p) => [p.id, p.username]));
    const nameOf = (id) => names.get(id) || s.username.get(id)?.username || '?';
    const table = standings(players.map((p) => ({ id: p.id, rating: p.rating })), pairings.map(toPairing));
    return {
      tournament: {
        id: t.id, clubId: t.club_id, name: t.name, format: t.format, play: t.play, rounds: t.rounds,
        timeControl: t.time_control ? (({ initial, increment }) => ({ initial: initial / 1000, increment: increment / 1000 }))(JSON.parse(t.time_control)) : null,
        rated: !!t.rated, status: t.status, currentRound: t.current_round, createdBy: t.created_by,
        organiser: nameOf(t.created_by),
      },
      players: players.map((p) => ({ id: p.id, username: p.username, rating: p.rating, withdrawn: !!p.withdrawn })),
      pairings: pairings.map((p) => ({
        id: p.id, round: p.round, board: p.board, result: p.result, gameId: p.game_id,
        white: { id: p.white_id, name: nameOf(p.white_id) },
        black: p.black_id ? { id: p.black_id, name: nameOf(p.black_id) } : null,
      })),
      standings: table.map((r) => ({ ...r, username: nameOf(r.id), withdrawn: players.find((p) => p.id === r.id)?.withdrawn === 1 })),
      canManage: canManage(user, t),
      joined: players.some((p) => p.id === user.id && !p.withdrawn),
    };
  }

  function summary(t) {
    const players = s.players.all(t.id).filter((p) => !p.withdrawn).length;
    return { id: t.id, name: t.name, format: t.format, play: t.play, rounds: t.rounds, status: t.status, currentRound: t.current_round, players };
  }

  /** Create the games for an online round (players just play; results come back via onGameFinished). */
  function createGames(t, round) {
    const tc = t.time_control ? JSON.parse(t.time_control) : null;
    const now = Date.now();
    for (const p of s.pairings.all(t.id).filter((x) => x.round === round && x.black_id && !x.game_id)) {
      const meta = { tournament: t.id, pairing: p.id, rated: !!t.rated, tournamentName: t.name, round };
      const { lastInsertRowid } = q.insertGame.run(
        t.club_id, 'online', 'club', 'active', p.white_id,
        p.white_id, p.black_id, s.username.get(p.white_id).username, s.username.get(p.black_id).username,
        'white', null, START_FEN, START_FEN, '[]', '*', null, JSON.stringify(meta), now, now,
        tc ? JSON.stringify(tc) : null, tc?.initial ?? null, tc?.initial ?? null, null,
      );
      s.setGame.run(Number(lastInsertRowid), p.id);
      notify(Number(lastInsertRowid));
    }
  }

  /** Pair round `round` and start it. */
  function pairRound(t, round) {
    const active = s.players.all(t.id).filter((p) => !p.withdrawn);
    const activeIds = new Set(active.map((p) => p.id));
    let pairs;
    if (t.format === 'roundrobin') {
      // Fixed schedule; a withdrawn player's opponent gets a bye.
      pairs = JSON.parse(t.schedule)[round - 1]
        .map((p) => {
          const w = activeIds.has(p.white) ? p.white : null;
          const b = p.black !== null && activeIds.has(p.black) ? p.black : null;
          if (w && b) return { white: w, black: b };
          if (w || b) return { white: w || b, black: null };
          return null;
        })
        .filter(Boolean);
    } else {
      pairs = swissRound(active.map((p) => ({ id: p.id, rating: p.rating })), s.pairings.all(t.id).map(toPairing));
    }
    pairs.forEach((p, i) => s.insertPairing.run(t.id, round, i + 1, p.white, p.black, p.black === null ? '1-0' : null));
    s.update.run('running', round, t.rounds, t.schedule, Date.now(), t.id);
    const fresh = s.get.get(t.id);
    if (t.play === 'online') createGames(fresh, round);
    maybeAdvance(fresh);
  }

  /** When every result of the current round is in, pair the next round (or finish). */
  function maybeAdvance(t) {
    if (t.status !== 'running') return;
    const current = s.pairings.all(t.id).filter((p) => p.round === t.current_round);
    if (current.some((p) => !p.result)) return changed(t);
    if (t.current_round >= t.rounds) {
      s.update.run('finished', t.current_round, t.rounds, t.schedule, Date.now(), t.id);
      return changed(t);
    }
    pairRound(t, t.current_round + 1);
  }

  /** Record a result; over-the-board results in rated tournaments update club ratings (once). */
  function recordResult(t, pairing, result, userId) {
    s.setResult.run(result, userId, pairing.id);
    if (t.rated && t.play === 'otb' && !pairing.rated && pairing.black_id) {
      ratings.rateResult({ clubId: t.club_id, whiteId: pairing.white_id, blackId: pairing.black_id, result, pairingId: pairing.id });
      s.markRated.run(pairing.id);
    }
    maybeAdvance(s.get.get(t.id));
  }

  // A finished online tournament game reports its own result.
  onGameFinished((g) => {
    const pairing = s.pairingByGame.get(g.id);
    if (!pairing || pairing.result || !RESULTS.has(g.result)) return;
    const t = s.get.get(pairing.tournament_id);
    if (t) recordResult(t, pairing, g.result, null);
  });

  // ---------- routes ----------

  app.get('/api/clubs/:id/tournaments', (req, res) => {
    const clubId = Number(req.params.id);
    if (!q.membership.get(clubId, req.user.id)) throw new HttpError(403, 'You are not a member of this club');
    res.json({ tournaments: s.byClub.all(clubId).map(summary) });
  });

  app.post('/api/clubs/:id/tournaments', (req, res) => {
    const clubId = Number(req.params.id);
    if (!q.membership.get(clubId, req.user.id)) throw new HttpError(403, 'You are not a member of this club');
    const body = req.body || {};
    const name = cleanText(body.name, 80);
    if (name.length < 2) throw new HttpError(400, 'Give the tournament a name');
    const format = body.format === 'roundrobin' ? 'roundrobin' : 'swiss';
    const play = body.play === 'online' ? 'online' : 'otb';
    const rounds = format === 'swiss' ? Math.min(15, Math.max(1, Math.round(Number(body.rounds)) || 4)) : 0;
    let tc = null;
    if (play === 'online') {
      try {
        tc = parseTimeControl(body.timeControl);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    const now = Date.now();
    const { lastInsertRowid } = s.insert.run(clubId, name, format, play, rounds, tc ? JSON.stringify(tc) : null, body.rated === false ? 0 : 1, req.user.id, now, now);
    const t = s.get.get(Number(lastInsertRowid));
    if (body.join !== false) s.addPlayer.run(t.id, req.user.id, now);
    changed(t);
    res.status(201).json(detail(t, req.user));
  });

  app.get('/api/tournaments/:id', (req, res) => {
    res.json(detail(load(req), req.user));
  });

  app.post('/api/tournaments/:id/join', (req, res) => {
    const t = load(req);
    if (t.status !== 'registration') throw new HttpError(409, 'Registration has closed');
    s.addPlayer.run(t.id, req.user.id, Date.now());
    changed(t);
    res.json(detail(t, req.user));
  });

  app.post('/api/tournaments/:id/leave', (req, res) => {
    const t = load(req);
    if (t.status === 'registration') s.removePlayer.run(t.id, req.user.id);
    else if (t.status === 'running') s.withdraw.run(t.id, req.user.id); // results so far still count
    else throw new HttpError(409, 'The tournament has finished');
    changed(t);
    res.json(detail(t, req.user));
  });

  // Organiser: add a member (handy for players without a phone at club night) or remove/withdraw one.
  app.post('/api/tournaments/:id/players', (req, res) => {
    const t = load(req);
    requireManager(req, t);
    const userId = Number(req.body?.userId);
    if (!q.membership.get(t.club_id, userId)) throw new HttpError(400, 'That player is not in the club');
    if (t.status !== 'registration') throw new HttpError(409, 'Players can only be added before the start');
    s.addPlayer.run(t.id, userId, Date.now());
    changed(t);
    res.json(detail(t, req.user));
  });

  app.delete('/api/tournaments/:id/players/:userId', (req, res) => {
    const t = load(req);
    requireManager(req, t);
    const userId = Number(req.params.userId);
    if (t.status === 'registration') s.removePlayer.run(t.id, userId);
    else if (t.status === 'running') s.withdraw.run(t.id, userId);
    else throw new HttpError(409, 'The tournament has finished');
    changed(t);
    res.json(detail(t, req.user));
  });

  app.post('/api/tournaments/:id/start', (req, res) => {
    const t = load(req);
    requireManager(req, t);
    if (t.status !== 'registration') throw new HttpError(409, 'The tournament has already started');
    const players = s.players.all(t.id).filter((p) => !p.withdrawn);
    if (players.length < 2) throw new HttpError(400, 'At least 2 players are needed');
    let { rounds } = t;
    let schedule = null;
    if (t.format === 'roundrobin') {
      const plan = roundRobin(players.map((p) => p.id)); // seeded by rating
      rounds = plan.length;
      schedule = JSON.stringify(plan);
    } else {
      rounds = Math.min(rounds, players.length - 1 + (players.length % 2));
    }
    s.update.run('running', 0, rounds, schedule, Date.now(), t.id);
    pairRound(s.get.get(t.id), 1);
    res.json(detail(s.get.get(t.id), req.user));
  });

  // Over-the-board results: either player in the pairing, or the organiser (who can also correct any result).
  app.post('/api/tournaments/:id/pairings/:pairingId/result', (req, res) => {
    const t = load(req);
    const pairing = s.pairing.get(Number(req.params.pairingId), t.id);
    if (!pairing) throw new HttpError(404, 'Pairing not found');
    const result = req.body?.result;
    if (!RESULTS.has(result)) throw new HttpError(400, 'Result must be 1-0, 0-1 or 1/2-1/2');
    if (!pairing.black_id) throw new HttpError(400, "A bye's result is fixed");
    const manager = canManage(req.user, t);
    const player = [pairing.white_id, pairing.black_id].includes(req.user.id);
    if (!manager && !player) throw new HttpError(403, 'Only the players or the organiser can report this result');
    if (!manager && pairing.result) throw new HttpError(409, 'A result was already reported — ask the organiser to correct it');
    if (!manager && t.play === 'online') throw new HttpError(409, 'This result comes from the online game');
    if (t.status === 'finished' && !manager) throw new HttpError(409, 'The tournament has finished');
    recordResult(t, pairing, result, req.user.id);
    res.json(detail(s.get.get(t.id), req.user));
  });

  app.post('/api/tournaments/:id/finish', (req, res) => {
    const t = load(req);
    requireManager(req, t);
    s.update.run('finished', t.current_round, t.rounds, t.schedule, Date.now(), t.id);
    changed(t);
    res.json(detail(s.get.get(t.id), req.user));
  });

  app.delete('/api/tournaments/:id', (req, res) => {
    const t = load(req);
    requireManager(req, t);
    if (t.status !== 'registration') throw new HttpError(409, 'Only tournaments that have not started can be deleted');
    s.remove.run(t.id);
    changed(t);
    res.json({ ok: true });
  });
}
