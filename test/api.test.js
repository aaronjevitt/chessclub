import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../server/app.js';

let server;
let db;
let base;

before(async () => {
  ({ server, db } = createServer({ dbFile: ':memory:' }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** Minimal cookie-keeping client. */
function client() {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    get cookie() { return cookie; },
  };
}

async function registered(name) {
  const c = client();
  const r = await c.post('/api/register', { username: name, password: 'secret123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.user = r.body.user;
  return c;
}

test('registration, login and auth guards', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/clubs')).status, 401);
  assert.equal((await anon.post('/api/register', { username: 'x', password: 'secret123' })).status, 400);
  assert.equal((await anon.post('/api/register', { username: 'alice0', password: '123' })).status, 400);

  const a = await registered('alice0');
  assert.equal((await a.get('/api/me')).body.user.username, 'alice0');
  assert.equal((await client().post('/api/register', { username: 'ALICE0', password: 'secret123' })).status, 409);

  const login = client();
  assert.equal((await login.post('/api/login', { username: 'alice0', password: 'wrong-pass' })).status, 401);
  assert.equal((await login.post('/api/login', { username: 'alice0', password: 'secret123' })).status, 200);
  assert.equal((await login.post('/api/logout')).status, 200);
  assert.equal((await login.get('/api/clubs')).status, 401);
});

test('clubs: create, discover, join, private invite codes', async () => {
  const owner = await registered('owner1');
  const other = await registered('other1');

  const pub = (await owner.post('/api/clubs', { name: 'Knights', description: 'Open club' })).body.club;
  const priv = (await owner.post('/api/clubs', { name: 'Secret Rooks', isPublic: false })).body.club;

  const discover = (await other.get('/api/clubs')).body.discover.map((c) => c.name);
  assert.ok(discover.includes('Knights'));
  assert.ok(!discover.includes('Secret Rooks'));

  assert.equal((await other.get(`/api/clubs/${pub.id}/games`)).status, 403);
  assert.equal((await other.post(`/api/clubs/${pub.id}/join`)).status, 200);
  assert.equal((await other.get(`/api/clubs/${pub.id}`)).body.members.length, 2);

  assert.equal((await other.post(`/api/clubs/${priv.id}/join`)).status, 403);
  const code = (await owner.get(`/api/clubs/${priv.id}`)).body.club.inviteCode;
  assert.equal((await other.post('/api/clubs/join-by-code', { code: code.toLowerCase() })).status, 200);
  assert.equal((await other.get('/api/clubs')).body.mine.length, 2);

  assert.equal((await owner.post(`/api/clubs/${pub.id}/leave`)).status, 400);
  assert.equal((await other.post(`/api/clubs/${pub.id}/leave`)).status, 200);
});

test('online game: challenge, accept, moves, turn enforcement, live spectating, checkmate', async () => {
  const a = await registered('white2');
  const b = await registered('black2');
  const spectator = await registered('watcher2');
  const club = (await a.post('/api/clubs', { name: 'Arena' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  await spectator.post(`/api/clubs/${club.id}/join`);

  const challenge = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white' })).body.game;
  assert.equal(challenge.status, 'waiting');
  assert.equal((await a.post(`/api/games/${challenge.id}/accept`)).status, 400);
  const accepted = (await b.post(`/api/games/${challenge.id}/accept`)).body.game;
  assert.equal(accepted.status, 'active');
  assert.equal(accepted.white.id, a.user.id);
  assert.equal(accepted.black.id, b.user.id);
  assert.equal((await spectator.post(`/api/games/${challenge.id}/accept`)).status, 409);

  // Spectator watches over Socket.IO.
  const socket = ioClient(base, { extraHeaders: { Cookie: spectator.cookie }, transports: ['websocket'] });
  const watched = await new Promise((resolve) => socket.emit('watch:game', challenge.id, resolve));
  assert.equal(watched.game.id, challenge.id);
  const updates = [];
  socket.on('game', (g) => updates.push(g));

  assert.equal((await b.post(`/api/games/${challenge.id}/move`, { from: 'e7', to: 'e5' })).status, 403);
  assert.equal((await spectator.post(`/api/games/${challenge.id}/move`, { from: 'e2', to: 'e4' })).status, 403);
  assert.equal((await a.post(`/api/games/${challenge.id}/move`, { from: 'e2', to: 'e5' })).status, 400);

  // Fool's mate with white to move first: 1. f3 e5 2. g4 Qh4#
  await a.post(`/api/games/${challenge.id}/move`, { san: 'f3' });
  await b.post(`/api/games/${challenge.id}/move`, { from: 'e7', to: 'e5' });
  await a.post(`/api/games/${challenge.id}/move`, { san: 'g4' });
  const final = (await b.post(`/api/games/${challenge.id}/move`, { san: 'Qh4#' })).body.game;
  assert.equal(final.status, 'finished');
  assert.equal(final.result, '0-1');
  assert.equal(final.termination, 'checkmate');
  assert.deepEqual(final.moves, ['f3', 'e5', 'g4', 'Qh4#']);

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(updates.at(-1).status, 'finished');
  assert.ok(updates.length >= 4);
  socket.close();
});

test('private online games are hidden from other members', async () => {
  const a = await registered('priva');
  const b = await registered('privb');
  const c = await registered('privc');
  const club = (await a.post('/api/clubs', { name: 'Quiet' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  await c.post(`/api/clubs/${club.id}/join`);

  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', opponentId: b.user.id, visibility: 'private' })).body.game;
  assert.equal((await c.post(`/api/games/${g.id}/accept`)).status, 404);
  assert.equal((await b.post(`/api/games/${g.id}/accept`)).status, 200);
  assert.equal((await c.get(`/api/games/${g.id}`)).status, 404);
  assert.equal((await c.get(`/api/clubs/${club.id}/games`)).body.active.length, 0);
  assert.equal((await b.get(`/api/clubs/${club.id}/games`)).body.active.length, 1);

  const socket = ioClient(base, { extraHeaders: { Cookie: c.cookie }, transports: ['websocket'] });
  const res = await new Promise((resolve) => socket.emit('watch:game', g.id, resolve));
  assert.equal(res.error, 'Game not found');
  socket.close();
});

test('draw offers and resignation', async () => {
  const a = await registered('drawa');
  const b = await registered('drawb');
  const club = (await a.post('/api/clubs', { name: 'Drawish' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);

  const g1 = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'black' })).body.game;
  await b.post(`/api/games/${g1.id}/accept`);
  assert.equal((await a.post(`/api/games/${g1.id}/draw`, { action: 'accept' })).status, 409);
  await a.post(`/api/games/${g1.id}/draw`, { action: 'offer' });
  const drawn = (await b.post(`/api/games/${g1.id}/draw`, { action: 'accept' })).body.game;
  assert.equal(drawn.result, '1/2-1/2');

  const g2 = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white' })).body.game;
  await b.post(`/api/games/${g2.id}/accept`);
  const resigned = (await b.post(`/api/games/${g2.id}/resign`)).body.game;
  assert.equal(resigned.result, '1-0');
  assert.equal(resigned.termination, 'black resigned');
});

test('broadcast games: computer, OTB, takeback, result, stop broadcast', async () => {
  const a = await registered('caster');
  const b = await registered('viewer');
  const club = (await a.post('/api/clubs', { name: 'Broadcasts' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);

  // Start broadcasting mid-game: the server replays and validates the move list.
  assert.equal((await a.post(`/api/clubs/${club.id}/games`, { mode: 'computer', moves: ['e4', 'e4'] })).status, 400);
  const comp = (await a.post(`/api/clubs/${club.id}/games`, {
    mode: 'computer', moves: ['e4', 'e5'], whiteName: 'caster', blackName: 'Computer', playerColor: 'white', level: 4,
  })).body.game;
  assert.equal(comp.status, 'active');
  assert.equal(comp.meta.level, 4);
  assert.deepEqual(comp.moves, ['e4', 'e5']);

  const live = (await b.get(`/api/clubs/${club.id}/games`)).body.active.map((g) => g.id);
  assert.ok(live.includes(comp.id));

  // Only the broadcaster can move (they relay the engine's moves too).
  assert.equal((await b.post(`/api/games/${comp.id}/move`, { san: 'Nf3' })).status, 403);
  await a.post(`/api/games/${comp.id}/move`, { san: 'Nf3' });
  await a.post(`/api/games/${comp.id}/move`, { san: 'Nc6' });
  const undone = (await a.post(`/api/games/${comp.id}/undo`, { count: 2 })).body.game;
  assert.deepEqual(undone.moves, ['e4', 'e5']);
  const resigned = (await a.post(`/api/games/${comp.id}/resign`)).body.game;
  assert.equal(resigned.result, '0-1');

  const otb = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'otb', whiteName: 'Magnus', blackName: 'Hikaru' })).body.game;
  assert.equal(otb.white.name, 'Magnus');
  assert.equal((await b.post(`/api/games/${otb.id}/result`, { result: '1-0' })).status, 403);
  assert.equal((await a.post(`/api/games/${otb.id}/result`, { result: '2-0' })).status, 400);
  assert.equal((await a.post(`/api/games/${otb.id}/result`, { result: '1/2-1/2' })).body.game.status, 'finished');

  const self = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'self' })).body.game;
  assert.equal((await b.post(`/api/games/${self.id}/cancel`)).status, 403);
  await a.post(`/api/games/${self.id}/move`, { san: 'e4' });
  const stopped = (await a.post(`/api/games/${self.id}/cancel`)).body.game;
  assert.equal(stopped.status, 'paused');
  assert.ok(!(await b.get(`/api/clubs/${club.id}/games`)).body.active.some((g) => g.id === self.id));
  assert.equal((await a.post(`/api/games/${self.id}/move`, { san: 'e5' })).status, 409);

  // A spectator keeps watching the same game id across stop/resume.
  const socket = ioClient(base, { extraHeaders: { Cookie: b.cookie }, transports: ['websocket'] });
  await new Promise((resolve) => socket.emit('watch:game', self.id, resolve));
  const seen = new Promise((resolve) => socket.on('game', resolve));
  assert.equal((await b.post(`/api/games/${self.id}/resume`, { moves: ['e4', 'e5'] })).status, 403);
  assert.equal((await a.post(`/api/games/${self.id}/resume`, { moves: ['e4', 'e4'] })).status, 400);
  const resumed = (await a.post(`/api/games/${self.id}/resume`, { moves: ['e4', 'e5', 'Nf3'] })).body.game;
  assert.equal(resumed.id, self.id);
  assert.equal(resumed.status, 'active');
  assert.deepEqual(resumed.moves, ['e4', 'e5', 'Nf3']);
  assert.deepEqual((await seen).moves, ['e4', 'e5', 'Nf3']);
  socket.close();
  assert.equal((await a.post(`/api/games/${self.id}/resume`)).status, 409);
});

test('sockets reject unauthenticated connections', async () => {
  const socket = ioClient(base, { transports: ['websocket'], reconnection: false });
  const err = await new Promise((resolve) => socket.on('connect_error', resolve));
  assert.equal(err.message, 'unauthorized');
  socket.close();
});

test('timed games: server-authoritative clocks, increment, flag on late move and by timer', async () => {
  const a = await registered('clocka');
  const b = await registered('clockb');
  const club = (await a.post('/api/clubs', { name: 'Blitz' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);

  assert.equal((await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', timeControl: { initial: 1 } })).status, 400);
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', timeControl: { initial: 60, increment: 2 } })).body.game;
  assert.deepEqual(g.timeControl, { initial: 60, increment: 2 });
  await b.post(`/api/games/${g.id}/accept`);

  // First move of each side is untimed.
  await a.post(`/api/games/${g.id}/move`, { san: 'e4' });
  let state = (await b.post(`/api/games/${g.id}/move`, { san: 'e5' })).body.game;
  assert.equal(state.clock.running, 'w');
  assert.ok(state.clock.white > 59900 && state.clock.white <= 60000, String(state.clock.white));
  assert.equal(state.clock.black, 60000);

  // White spends ~10s (simulated by moving the turn start back), then gets the 2s increment.
  db.prepare('UPDATE games SET turn_started_at = turn_started_at - 10000 WHERE id = ?').run(g.id);
  state = (await a.post(`/api/games/${g.id}/move`, { san: 'Nf3' })).body.game;
  assert.ok(state.clock.white <= 52000 && state.clock.white > 51500, String(state.clock.white));
  assert.equal(state.clock.running, 'b');

  // Black's time has run out: a late move is refused and the game is lost on time.
  db.prepare('UPDATE games SET turn_started_at = turn_started_at - 61000 WHERE id = ?').run(g.id);
  const late = await b.post(`/api/games/${g.id}/move`, { san: 'Nc6' });
  assert.equal(late.status, 409);
  state = (await a.get(`/api/games/${g.id}`)).body.game;
  assert.equal(state.status, 'finished');
  assert.equal(state.result, '1-0');
  assert.equal(state.termination, 'black ran out of time');
  assert.equal(state.clock.black, 0);
  assert.equal(state.clock.running, null);

  // Flag by timer, with nobody making a request: white has 150ms left.
  const g2 = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', timeControl: { initial: 60 } })).body.game;
  await b.post(`/api/games/${g2.id}/accept`);
  await a.post(`/api/games/${g2.id}/move`, { san: 'd4' });
  await b.post(`/api/games/${g2.id}/move`, { san: 'd5' });
  db.prepare('UPDATE games SET white_ms = 150 WHERE id = ?').run(g2.id);
  await a.post(`/api/games/${g2.id}/draw`, { action: 'offer' }); // any action reschedules the flag timer
  const socket = ioClient(base, { extraHeaders: { Cookie: b.cookie }, transports: ['websocket'] });
  await new Promise((resolve) => socket.emit('watch:game', g2.id, resolve));
  const flagged = await new Promise((resolve) => socket.on('game', (s) => s.status === 'finished' && resolve(s)));
  assert.equal(flagged.result, '0-1');
  assert.equal(flagged.termination, 'white ran out of time');
  socket.close();

  // Resigning freezes the clock.
  const g3 = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', timeControl: { initial: 30 } })).body.game;
  await b.post(`/api/games/${g3.id}/accept`);
  await a.post(`/api/games/${g3.id}/move`, { san: 'c4' });
  await b.post(`/api/games/${g3.id}/move`, { san: 'c5' });
  const resigned = (await a.post(`/api/games/${g3.id}/resign`)).body.game;
  assert.equal(resigned.clock.running, null);
  assert.ok(resigned.clock.white > 29000);

  // Untimed games have no clock.
  const g4 = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online' })).body.game;
  assert.equal(g4.clock, null);
  assert.equal(g4.timeControl, null);
});

test('timed broadcast computer game continues from the broadcaster clock readings', async () => {
  const a = await registered('clockcast');
  const club = (await a.post('/api/clubs', { name: 'Cast' })).body.club;
  const g = (await a.post(`/api/clubs/${club.id}/games`, {
    mode: 'computer', playerColor: 'white', level: 1, moves: ['e4', 'e5'],
    timeControl: { initial: 180, increment: 2 }, whiteMs: 170000, blackMs: 175000,
  })).body.game;
  assert.equal(g.clock.running, 'w');
  assert.ok(g.clock.white <= 170000 && g.clock.white > 169000);
  assert.equal(g.clock.black, 175000);
  const paused = (await a.post(`/api/games/${g.id}/cancel`)).body.game;
  assert.equal(paused.clock.running, null);
  const resumed = (await a.post(`/api/games/${g.id}/resume`, { moves: ['e4', 'e5', 'Nf3'], whiteMs: 150000, blackMs: 160000 })).body.game;
  assert.equal(resumed.clock.running, 'b');
  assert.ok(resumed.clock.black <= 160000 && resumed.clock.black > 159000);
  assert.equal(resumed.clock.white, 150000);
});
