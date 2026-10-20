import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openDb } from './db.js';
import { createAuth, hashPassword, verifyPassword } from './auth.js';
import { START_FEN, replay, gameOverInfo, tryMove, isValidFen } from './chesslogic.js';

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

export function createServer({ dbFile = path.join(ROOT, 'data', 'chessclub.db') } = {}) {
  const db = openDb(dbFile);
  const auth = createAuth(db);
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(auth.attachUser);
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/vendor/chess.js', (_req, res) => {
    res.sendFile(path.join(ROOT, 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js'));
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
        creator_color, invited_id, start_fen, fen, moves, result, termination, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };

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
      white: { id: g.white_id, name: g.white_name },
      black: { id: g.black_id, name: g.black_name },
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
    const g = q.game.get(gameId);
    if (!g) return;
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
    const moves = JSON.parse(g.moves);
    const chess = replay(g.start_fen, moves);
    const san = tryMove(chess, move);
    if (!san) throw new HttpError(400, 'Illegal move');
    moves.push(san);
    const fields = { fen: chess.fen(), moves: JSON.stringify(moves), draw_offer_by: null };
    const over = gameOverInfo(chess);
    if (over) Object.assign(fields, { status: 'finished', result: over.result, termination: over.termination });
    updateGame(g.id, fields);
    return notify(g.id);
  }

  // ---------- auth routes ----------

  app.post('/api/register', (req, res) => {
    const username = cleanText(req.body?.username, 40);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
      throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers, _ or -');
    }
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken');
    const { hash, salt } = hashPassword(password);
    const { lastInsertRowid } = q.insertUser.run(username, hash, salt, Date.now());
    auth.createSession(res, Number(lastInsertRowid));
    res.status(201).json({ user: { id: Number(lastInsertRowid), username } });
  });

  app.post('/api/login', (req, res) => {
    const username = cleanText(req.body?.username, 40);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = q.userByName.get(username);
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      throw new HttpError(401, 'Invalid username or password');
    }
    auth.createSession(res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: req.user });
  });

  app.use('/api', auth.requireUser);

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
      const { lastInsertRowid } = q.insertGame.run(
        club.id, 'online', visibility, 'waiting', me.id,
        color === 'white' ? me.id : null, color === 'black' ? me.id : null,
        color === 'white' ? me.username : null, color === 'black' ? me.username : null,
        color, invitedId, START_FEN, START_FEN, '[]', '*', null, '{}', now, now,
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
        meta.level = Math.min(5, Math.max(1, Number(body.level) || 3));
      }
      if (body.localId) meta.localId = cleanText(body.localId, 64);
      if (mode === 'otb') meta.event = cleanText(body.event, 80);
      const over = gameOverInfo(chess);
      const { lastInsertRowid } = q.insertGame.run(
        club.id, mode, 'club', over ? 'finished' : 'active', me.id,
        null, null, whiteName, blackName, null, null,
        startFen, chess.fen(), JSON.stringify(sanMoves),
        over ? over.result : '*', over ? over.termination : null, JSON.stringify(meta), now, now,
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
      // Stopping a broadcast: the game continues privately on the broadcaster's device.
      if (g.created_by !== me.id) throw new HttpError(403, 'Only the broadcaster can stop this broadcast');
      updateGame(g.id, { status: 'aborted', termination: 'broadcast stopped' });
    } else if (g.status === 'active' && g.mode === 'online' && JSON.parse(g.moves).length < 2) {
      if (g.white_id !== me.id && g.black_id !== me.id) throw new HttpError(403, 'Not your game');
      updateGame(g.id, { status: 'aborted', termination: 'aborted' });
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
    updateGame(g.id, {
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
        updateGame(g.id, { status: 'finished', result: '1/2-1/2', termination: 'draw agreed', draw_offer_by: null });
      } else {
        updateGame(g.id, { draw_offer_by: me.id });
      }
    } else if (action === 'accept') {
      if (!g.draw_offer_by || g.draw_offer_by === me.id) throw new HttpError(409, 'There is no draw offer to accept');
      updateGame(g.id, { status: 'finished', result: '1/2-1/2', termination: 'draw agreed', draw_offer_by: null });
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
    updateGame(g.id, { status: 'finished', result, termination: cleanText(req.body?.termination, 60) || 'result declared' });
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
    updateGame(g.id, { moves: JSON.stringify(moves), fen: chess.fen() });
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

  return { app, server, io, db };
}
