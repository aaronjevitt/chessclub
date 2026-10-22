import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../server/app.js';

let server;
let db;
let maintenance;
let base;

before(async () => {
  ({ server, db, maintenance } = createServer({ dbFile: ':memory:', rateLimits: false }));
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

test('computer games store the bot Elo; Stockfish files are served', async () => {
  const a = await registered('botfan');
  const club = (await a.post('/api/clubs', { name: 'Bots' })).body.club;
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'computer', elo: 2100, bot: 'Eva', blackName: 'Eva (2100)' })).body.game;
  assert.equal(g.meta.elo, 2100);
  assert.equal(g.meta.bot, 'Eva');
  const clamped = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'computer', elo: 99999 })).body.game;
  assert.equal(clamped.meta.elo, 3190);
  const legacy = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'computer', level: 4 })).body.game;
  assert.equal(legacy.meta.level, 4);

  const js = await fetch(`${base}/vendor/stockfish/stockfish-19-lite-single.js`);
  assert.equal(js.status, 200);
  const wasm = await fetch(`${base}/vendor/stockfish/stockfish-19-lite-single.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(`${base}/vendor/stockfish/stockfish-19.wasm`)).status, 404);
  assert.equal((await fetch(`${base}/vendor/stockfish/..%2fpackage.json`)).status, 404);
});

test('eval bar move limit is stored and validated', async () => {
  const a = await registered('evalfade');
  const club = (await a.post('/api/clubs', { name: 'Fade' })).body.club;
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', evalBar: true, evalBarMoves: 10 })).body.game;
  assert.deepEqual(g.meta, { evalBar: true, evalBarMoves: 10, rated: true });
  const bad = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'computer', evalBar: true, evalBarMoves: 999 })).body.game;
  assert.equal(bad.meta.evalBar, true);
  assert.equal(bad.meta.evalBarMoves, undefined);
  const off = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'self', evalBarMoves: 10 })).body.game;
  assert.equal(off.meta.evalBar, undefined);
});

test('maintenance aborts unstarted timed games, stale paused broadcasts and old challenges', async () => {
  const a = await registered('sweeper');
  const b = await registered('sweepee');
  const club = (await a.post('/api/clubs', { name: 'Sweep' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  const timed = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', timeControl: { initial: 60 } })).body.game;
  await b.post(`/api/games/${timed.id}/accept`);
  const cast = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'self' })).body.game;
  await a.post(`/api/games/${cast.id}/cancel`); // paused
  const open = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online' })).body.game;
  const fresh = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online' })).body.game;

  const age = (id, ms) => db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(Date.now() - ms, id);
  age(timed.id, 11 * 60 * 1000);
  age(cast.id, 25 * 60 * 60 * 1000);
  age(open.id, 8 * 24 * 60 * 60 * 1000);
  const changed = maintenance.sweep();
  assert.deepEqual(new Set(changed), new Set([timed.id, cast.id, open.id]));
  assert.equal((await a.get(`/api/games/${timed.id}`)).body.game.status, 'aborted');
  assert.equal((await a.get(`/api/games/${fresh.id}`)).body.game.status, 'waiting');
});

test('club owner tools: edit, privacy, new invite code, remove member', async () => {
  const owner = await registered('adminown');
  const member = await registered('adminmem');
  const club = (await owner.post('/api/clubs', { name: 'Admin Club' })).body.club;
  await member.post(`/api/clubs/${club.id}/join`);
  const patch = (c, body) => fetch(`${base}/api/clubs/${club.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: c.cookie }, body: JSON.stringify(body) });

  assert.equal((await patch(member, { name: 'Hacked' })).status, 403);
  assert.equal((await patch(owner, { name: 'Renamed Club', description: 'Thursdays', isPublic: false })).status, 200);
  const detail = (await member.get(`/api/clubs/${club.id}`)).body.club;
  assert.equal(detail.name, 'Renamed Club');
  assert.equal(detail.isPublic, false);

  const oldCode = (await owner.get(`/api/clubs/${club.id}`)).body.club.inviteCode;
  const { inviteCode } = (await owner.post(`/api/clubs/${club.id}/invite-code`)).body;
  assert.notEqual(inviteCode, oldCode);
  const newcomer = await registered('adminnew');
  assert.equal((await newcomer.post('/api/clubs/join-by-code', { code: oldCode })).status, 404);
  assert.equal((await newcomer.post('/api/clubs/join-by-code', { code: inviteCode })).status, 200);

  const challenge = (await member.post(`/api/clubs/${club.id}/games`, { mode: 'online' })).body.game;
  const del = (c, uid) => fetch(`${base}/api/clubs/${club.id}/members/${uid}`, { method: 'DELETE', headers: { Cookie: c.cookie } });
  assert.equal((await del(member, owner.user.id)).status, 403);
  assert.equal((await del(owner, member.user.id)).status, 200);
  assert.equal((await member.get(`/api/clubs/${club.id}/games`)).status, 403);
  assert.equal((await owner.get(`/api/games/${challenge.id}`)).body.game.status, 'aborted');
});

test('rated games update club ratings once; casual games do not; leaderboard', async () => {
  const a = await registered('ratera');
  const b = await registered('raterb');
  const club = (await a.post('/api/clubs', { name: 'Rated Club' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  const play = async (opts, moves, finish) => {
    const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', opponentId: b.user.id, ...opts })).body.game;
    await b.post(`/api/games/${g.id}/accept`);
    for (const [i, san] of moves.entries()) await (i % 2 ? b : a).post(`/api/games/${g.id}/move`, { san });
    if (finish) await finish(g);
    return (await a.get(`/api/games/${g.id}`)).body.game;
  };
  const fools = await play({}, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepEqual(fools.meta.ratings, { w: { before: 1200, after: 1180, delta: -20 }, b: { before: 1200, after: 1220, delta: 20 } });
  assert.equal(fools.white.rating, 1180);

  const casual = await play({ rated: false }, ['e4', 'e5'], (g) => a.post(`/api/games/${g.id}/resign`));
  assert.equal(casual.meta.ratings, undefined);

  // Resignation before both sides moved is not rated.
  const early = await play({}, ['e4'], (g) => a.post(`/api/games/${g.id}/resign`));
  assert.equal(early.meta.ratings, undefined);

  const drawn = await play({}, ['d4', 'd5'], async (g) => {
    await a.post(`/api/games/${g.id}/draw`, { action: 'offer' });
    await b.post(`/api/games/${g.id}/draw`, { action: 'accept' });
  });
  assert.ok(drawn.meta.ratings.w.delta > 0, 'lower-rated White gains from a draw');

  const board = (await a.get(`/api/clubs/${club.id}/leaderboard`)).body.leaderboard;
  assert.deepEqual(board.map((r) => [r.username, r.games, r.wins, r.draws, r.losses]),
    [[b.user.username, 2, 1, 1, 0], [a.user.username, 2, 0, 1, 1]]);
  assert.ok(board[0].provisional);
});

test('profiles: shared-club privacy, ratings history, records and review accuracy', async () => {
  const a = await registered('profa');
  const b = await registered('profb');
  const stranger = await registered('profx');
  const club = (await a.post('/api/clubs', { name: 'Profile Club' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', opponentId: b.user.id })).body.game;
  await b.post(`/api/games/${g.id}/accept`);
  for (const [i, san] of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'].entries()) await (i % 2 ? b : a).post(`/api/games/${g.id}/move`, { san });
  const pos = (best, cp, mate = null) => ({ best, cp, mate, alt: null, cp2: null, mate2: null });
  const positions = [pos('e2e4', 30), pos('e7e5', 30), pos('g1f3', 30), pos('b8c6', 0), pos('f1c4', 20), pos('g7g6', -20), pos('h5f7', null, 1), pos(null, 100000, 0)];
  const saved = (await b.post(`/api/games/${g.id}/analysis`, { analysis: { engine: 'test', timeMs: 1, positions } })).body.analysis;
  assert.ok(saved.summary.accuracy.w > saved.summary.accuracy.b);

  assert.equal((await stranger.get(`/api/users/${a.user.id}`)).status, 404);
  const p = (await b.get(`/api/users/${a.user.id}`)).body;
  assert.equal(p.user.username, a.user.username);
  assert.equal(p.user.isMe, false);
  assert.deepEqual(p.record.members, { w: 1, d: 0, l: 0 });
  assert.equal(p.clubs[0].rating, 1220);
  assert.equal(p.clubs[0].history.length, 1);
  assert.equal(p.reviewedGames, 1);
  assert.equal(p.accuracy, saved.summary.accuracy.w);
  assert.equal(p.recent[0].colour, 'w');
  assert.equal((await a.get(`/api/users/${a.user.id}`)).body.user.isMe, true);
});

test('puzzles: your own mistakes from reviewed games, with progress', async () => {
  const a = await registered('puza');
  const b = await registered('puzb');
  const club = (await a.post('/api/clubs', { name: 'Puzzle Club' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', opponentId: b.user.id })).body.game;
  await b.post(`/api/games/${g.id}/accept`);
  for (const [i, san] of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'].entries()) await (i % 2 ? b : a).post(`/api/games/${g.id}/move`, { san });
  const pos = (best, cp, mate = null) => ({ best, cp, mate, alt: null, cp2: null, mate2: null });
  const positions = [pos('e2e4', 30), pos('e7e5', 30), pos('g1f3', 30), pos('b8c6', 0), pos('f1c4', 20), pos('g7g6', -20), pos('h5f7', null, 1), pos(null, 100000, 0)];
  assert.equal((await b.get('/api/puzzles')).body.stats.total, 0);
  await a.post(`/api/games/${g.id}/analysis`, { analysis: { engine: 'test', timeMs: 1, positions } });

  const { puzzles, stats } = (await b.get('/api/puzzles')).body;
  assert.deepEqual(stats, { total: 1, new: 1, solved: 0, failed: 0 });
  assert.deepEqual([puzzles[0].ply, puzzles[0].played, puzzles[0].bestSan, puzzles[0].label, puzzles[0].opponent], [6, 'Nf6', 'g6', 'blunder', a.user.username]);
  assert.equal(puzzles[0].fen.split(' ')[1], 'b');
  assert.equal((await a.get('/api/puzzles')).body.stats.total, 0, "White's moves were fine");

  assert.equal((await a.post('/api/puzzles/attempt', { gameId: g.id, ply: 6, solved: true })).status, 404, "not White's puzzle");
  assert.equal((await b.post('/api/puzzles/attempt', { gameId: g.id, ply: 5, solved: true })).status, 404);
  await b.post('/api/puzzles/attempt', { gameId: g.id, ply: 6, solved: false });
  assert.equal((await b.get('/api/puzzles')).body.puzzles[0].status, 'failed');
  await b.post('/api/puzzles/attempt', { gameId: g.id, ply: 6, solved: true });
  const after = (await b.get('/api/puzzles')).body;
  assert.deepEqual([after.puzzles[0].status, after.puzzles[0].solved, after.puzzles[0].failed], ['solved', 1, 1]);
});

test('OTB round-robin tournament: reported results, auto-advance, ratings, standings', async () => {
  const org = await registered('rrorg');
  const p2 = await registered('rrtwo');
  const p3 = await registered('rrthree');
  const outsider = await registered('rrout');
  const club = (await org.post('/api/clubs', { name: 'RR Club' })).body.club;
  for (const p of [p2, p3]) await p.post(`/api/clubs/${club.id}/join`);
  let t = (await org.post(`/api/clubs/${club.id}/tournaments`, { name: 'Autumn RR', format: 'roundrobin', play: 'otb' })).body;
  const id = t.tournament.id;
  await p2.post(`/api/tournaments/${id}/join`);
  assert.equal((await p3.post(`/api/tournaments/${id}/start`)).status, 403);
  assert.equal((await outsider.get(`/api/tournaments/${id}`)).status, 404);
  await org.post(`/api/tournaments/${id}/players`, { userId: p3.user.id }); // organiser adds a player
  t = (await org.post(`/api/tournaments/${id}/start`)).body;
  assert.equal(t.tournament.rounds, 3);
  assert.equal(t.tournament.currentRound, 1);
  const clients = new Map([[org.user.id, org], [p2.user.id, p2], [p3.user.id, p3]]);
  for (let round = 1; round <= 3; round++) {
    const games = t.pairings.filter((p) => p.round === round && p.black);
    assert.equal(games.length, 1);
    assert.equal(t.pairings.filter((p) => p.round === round && !p.black).length, 1, 'one bye per round');
    const g = games[0];
    assert.equal((await outsider.post(`/api/tournaments/${id}/pairings/${g.id}/result`, { result: '1-0' })).status, 404);
    // White reports a win; a second report by the other player is refused.
    t = (await clients.get(g.white.id).post(`/api/tournaments/${id}/pairings/${g.id}/result`, { result: '1-0' })).body;
    if (g.black.id !== org.user.id) { // the organiser may correct results; other players can't overwrite one
      assert.equal((await clients.get(g.black.id).post(`/api/tournaments/${id}/pairings/${g.id}/result`, { result: '0-1' })).status, 409);
    }
    t = (await org.get(`/api/tournaments/${id}`)).body;
  }
  assert.equal(t.tournament.status, 'finished');
  assert.equal(t.standings.reduce((sum, r) => sum + r.points, 0), 6); // 3 games + 3 byes
  const board = (await org.get(`/api/clubs/${club.id}/leaderboard`)).body.leaderboard;
  assert.equal(board.reduce((n, r) => n + r.games, 0), 6, 'each OTB game rated for both players');
  const list = (await p2.get(`/api/clubs/${club.id}/tournaments`)).body.tournaments;
  assert.equal(list[0].status, 'finished');
});

test('online Swiss tournament: games created per round, results flow back, winners meet', async () => {
  const ps = [];
  for (const n of ['swa', 'swb', 'swc', 'swd']) ps.push(await registered(n));
  const club = (await ps[0].post('/api/clubs', { name: 'Swiss Club' })).body.club;
  for (const p of ps.slice(1)) await p.post(`/api/clubs/${club.id}/join`);
  let t = (await ps[0].post(`/api/clubs/${club.id}/tournaments`, { name: 'Blitz Swiss', format: 'swiss', rounds: 2, play: 'online', timeControl: { initial: 180, increment: 2 } })).body;
  const id = t.tournament.id;
  for (const p of ps.slice(1)) await p.post(`/api/tournaments/${id}/join`);
  t = (await ps[0].post(`/api/tournaments/${id}/start`)).body;
  const byId = new Map(ps.map((p) => [p.user.id, p]));
  const playRound = async (round) => {
    for (const pairing of t.pairings.filter((p) => p.round === round)) {
      const game = (await ps[0].get(`/api/games/${pairing.gameId}`)).body.game;
      assert.equal(game.status, 'active');
      assert.deepEqual(game.timeControl, { initial: 180, increment: 2 });
      assert.equal((await byId.get(pairing.white.id).post(`/api/games/${game.id}/cancel`)).status, 409, 'cannot abort');
      const w = byId.get(pairing.white.id);
      const b = byId.get(pairing.black.id);
      for (const [i, san] of ['f3', 'e5', 'g4', 'Qh4#'].entries()) await (i % 2 ? b : w).post(`/api/games/${game.id}/move`, { san });
    }
    t = (await ps[0].get(`/api/tournaments/${id}`)).body;
  };
  await playRound(1);
  assert.equal(t.tournament.currentRound, 2);
  const winners = new Set(t.pairings.filter((p) => p.round === 1).map((p) => p.black.id)); // black mated white
  const top = t.pairings.find((p) => p.round === 2 && p.board === 1);
  assert.ok(winners.has(top.white.id) && winners.has(top.black.id), 'round-1 winners meet on board 1');
  await playRound(2);
  assert.equal(t.tournament.status, 'finished');
  assert.equal(t.standings[0].points, 2);
});
