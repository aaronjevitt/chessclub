// Lichess integration against a small stand-in for lichess.org that follows the published API
// (OAuth PKCE, NDJSON event/game streams, seeks, challenges, Board API moves).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../server/app.js';
import { clockProblem, replayUci, lichessResult } from '../server/lichess.js';

// ---------- fake lichess.org ----------
const fake = { challenges: new Map(), eventStreams: new Set(), gameStreams: new Map(), games: new Map(), seeks: new Set(), challengeStreams: new Map(), requests: [] };
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const send = (res, obj) => res.write(`${JSON.stringify(obj)}\n`);
const ME = { id: 'alice', username: 'Alice', perfs: { rapid: { games: 12, rating: 1650, rd: 60, prog: 5 }, blitz: { games: 0, rating: 1500, rd: 500, prog: 0, prov: true } } };

function startGame(id, { white = ME.id, black = 'bob', aiLevel = null } = {}) {
  const player = (pid) => (pid === 'ai' ? { aiLevel, id: '', name: `AI level ${aiLevel}` } : { id: pid, name: pid === ME.id ? ME.username : 'Bob', rating: pid === ME.id ? 1650 : 1700 });
  const game = { id, white: player(white), black: player(black), moves: [], status: 'started', winner: null };
  fake.games.set(id, game);
  for (const res of fake.eventStreams) send(res, { type: 'gameStart', game: { gameId: id, fullId: `${id}abcd`, color: white === ME.id ? 'white' : 'black' } });
  return game;
}
const state = (g) => ({ type: 'gameState', moves: g.moves.join(' '), wtime: 600000, btime: 600000, winc: 5000, binc: 5000, status: g.status, ...(g.winner ? { winner: g.winner } : {}) });
function pushState(g) {
  for (const res of fake.gameStreams.get(g.id) || []) {
    send(res, state(g));
    if (g.status !== 'started') res.end();
  }
}

let lichess;
function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}
const authed = (req) => req.headers.authorization === 'Bearer tok-alice';

before(async () => {
  lichess = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const form = req.method === 'POST' ? await readForm(req) : {};
    fake.requests.push({ method: req.method, path: p, form });
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (p === '/api/token' && req.method === 'POST') {
      const ok = form.grant_type === 'authorization_code' && form.code === 'good-code'
        && b64url(crypto.createHash('sha256').update(form.code_verifier || '').digest()) === fake.codeChallenge
        && form.redirect_uri === fake.redirectUri && form.client_id === fake.clientId;
      return ok ? json(200, { token_type: 'Bearer', access_token: 'tok-alice', expires_in: 31536000 }) : json(400, { error: 'invalid_grant' });
    }
    if (p === '/api/token' && req.method === 'DELETE') { fake.revoked = true; res.writeHead(204); return res.end(); }
    if (!authed(req)) return json(401, { error: 'No such token' });
    if (p === '/api/account') return json(200, ME);
    const ndjsonHead = () => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.flushHeaders(); };
    if (p === '/api/stream/event') {
      ndjsonHead();
      res.write('\n');
      fake.eventStreams.add(res);
      req.on('close', () => fake.eventStreams.delete(res));
      for (const c of fake.challenges.values()) send(res, { type: 'challenge', challenge: c });
      return;
    }
    if (p === '/api/board/seek') {
      if (Number(form.time) * 60 + 40 * Number(form.increment) < 480) return json(400, { error: 'Invalid time control' });
      ndjsonHead();
      fake.seeks.add(res);
      fake.lastSeek = form;
      req.on('close', () => fake.seeks.delete(res));
      return;
    }
    let m;
    if ((m = p.match(/^\/api\/board\/game\/stream\/(\w+)$/))) {
      const g = fake.games.get(m[1]);
      if (!g) return json(404, { error: 'Not found' });
      ndjsonHead();
      send(res, { type: 'gameFull', id: g.id, variant: { key: 'standard' }, clock: { initial: 600000, increment: 5000 }, speed: 'rapid', perf: { name: 'Rapid' }, rated: true, createdAt: Date.now(), white: g.white, black: g.black, initialFen: 'startpos', state: state(g) });
      if (!fake.gameStreams.has(g.id)) fake.gameStreams.set(g.id, new Set());
      fake.gameStreams.get(g.id).add(res);
      req.on('close', () => fake.gameStreams.get(g.id)?.delete(res));
      return;
    }
    if ((m = p.match(/^\/api\/board\/game\/(\w+)\/move\/(\w+)$/))) {
      const g = fake.games.get(m[1]);
      if (!g || g.status !== 'started') return json(400, { error: 'Not your turn, or game already over' });
      g.moves.push(m[2]);
      pushState(g);
      return json(200, { ok: true });
    }
    if ((m = p.match(/^\/api\/board\/game\/(\w+)\/resign$/))) {
      const g = fake.games.get(m[1]);
      g.status = 'resign';
      g.winner = g.white.id === ME.id ? 'black' : 'white';
      pushState(g);
      return json(200, { ok: true });
    }
    if ((m = p.match(/^\/api\/challenge\/(\w+)\/accept$/))) {
      const c = fake.challenges.get(m[1]);
      if (!c) return json(404, { error: 'Challenge not found' });
      fake.challenges.delete(c.id);
      startGame('accepted1', { white: 'bob', black: ME.id });
      return json(200, { ok: true });
    }
    if (p === '/api/challenge/ai') {
      startGame('aigame01', { white: ME.id, black: 'ai', aiLevel: Number(form.level) });
      return json(201, { id: 'aigame01' });
    }
    if ((m = p.match(/^\/api\/challenge\/(\w+)\/cancel$/))) {
      fake.challengeStreams.get(m[1])?.end();
      return json(200, { ok: true });
    }
    if ((m = p.match(/^\/api\/challenge\/(\w+)$/)) && req.method === 'POST') {
      if (m[1] === 'nobody') return json(400, { error: 'User not found' });
      ndjsonHead();
      const c = { id: 'out1', status: 'created', challenger: { id: ME.id, name: ME.username }, destUser: { id: m[1].toLowerCase(), name: m[1] }, timeControl: { type: 'clock', limit: Number(form['clock.limit']), increment: Number(form['clock.increment']), show: '5+3' }, rated: form.rated === 'true', speed: 'blitz' };
      fake.lastChallenge = form;
      send(res, c);
      fake.challengeStreams.set('out1', res);
      return;
    }
    json(404, { error: 'Not found' });
  });
  await new Promise((r) => lichess.listen(0, r));
});

let server;
let base;
before(async () => {
  ({ server } = createServer({ dbFile: ':memory:', rateLimits: false, lichessHost: `http://localhost:${lichess.address().port}` }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => { lichess.closeAllConnections(); lichess.close(r); })]));

function client() {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* redirect */ }
    return { status: res.status, body: json, location: res.headers.get('location') };
  }
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), get cookie() { return cookie; } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await wait(25);
  }
}

test('clock rules and UCI helpers', () => {
  assert.match(clockProblem({ limit: 300, increment: 0 }, 'seek'), /rapid or slower/);
  assert.equal(clockProblem({ limit: 600, increment: 0 }, 'seek'), null);
  assert.equal(clockProblem({ limit: 300, increment: 3 }, 'challenge'), null);
  assert.match(clockProblem({ limit: 60, increment: 0 }, 'challenge'), /blitz or slower/);
  assert.match(clockProblem({ limit: 100, increment: 0 }, 'challenge'), /whole minutes/);
  // King-to-rook castling from Lichess becomes normal castling.
  const { chess, lastMove } = replayUci('startpos', ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1h1']);
  assert.equal(chess.history().at(-1), 'O-O');
  assert.deepEqual(lastMove, { from: 'e1', to: 'g1' });
  assert.equal(replayUci('startpos', ['e2e4', 'e7e5', 'e1e2']).chess.history().at(-1), 'Ke2');
  assert.equal(lichessResult('resign', 'black'), '0-1');
  assert.equal(lichessResult('draw'), '1/2-1/2');
  assert.equal(lichessResult('aborted'), null);
});

test('connect with OAuth PKCE, play a seek game, import it, ratings stay separate', async () => {
  const a = client();
  const user = (await a.post('/api/register', { username: 'clubalice', password: 'secret123' })).body.user;
  const club = (await a.post('/api/clubs', { name: 'Lichess Club' })).body.club;
  assert.deepEqual((await a.get('/api/lichess')).body, { connected: false });
  assert.equal((await a.post('/api/lichess/seek', { limit: 600, increment: 0 })).status, 409);

  // Start OAuth: the app sends the browser to /oauth with a PKCE challenge.
  const { url } = (await a.post('/api/lichess/connect')).body;
  const auth = new URL(url);
  assert.equal(auth.pathname, '/oauth');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'board:play challenge:read challenge:write');
  fake.codeChallenge = auth.searchParams.get('code_challenge');
  fake.redirectUri = auth.searchParams.get('redirect_uri');
  fake.clientId = auth.searchParams.get('client_id');
  assert.ok(fake.redirectUri.endsWith('/lichess/callback'));
  // A wrong state is refused; Lichess then redirects back with the code.
  assert.match((await a.get('/lichess/callback?code=good-code&state=forged')).location, /lichess=expired/);
  const back = await a.get(`/lichess/callback?code=good-code&state=${auth.searchParams.get('state')}`);
  assert.equal(back.status, 302);
  assert.equal(back.location, `/#/player/${user.id}?lichess=connected`);

  // Live events reach the browser over Socket.IO.
  const socket = ioClient(base, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'] });
  const events = [];
  socket.onAny((name, data) => events.push([name, data]));
  await new Promise((r) => socket.on('connect', r));

  const st = (await a.get('/api/lichess')).body;
  assert.equal(st.username, 'Alice');
  assert.deepEqual(st.ratings, [{ speed: 'rapid', rating: 1650, games: 12, provisional: false }]);
  const profile = (await a.get(`/api/users/${user.id}`)).body;
  assert.equal(profile.lichess.username, 'Alice');
  assert.equal(profile.clubs[0].rating, 1200, 'club rating untouched by Lichess');

  // Seeks must be rapid or slower.
  assert.equal((await a.post('/api/lichess/seek', { limit: 180, increment: 2 })).status, 400);
  assert.equal((await a.post('/api/lichess/seek', { limit: 600, increment: 5, rated: true })).status, 202);
  assert.deepEqual([fake.lastSeek.time, fake.lastSeek.increment, fake.lastSeek.rated], ['10', '5', 'true']);
  assert.ok((await a.get('/api/lichess')).body.seeking);
  assert.equal((await a.post('/api/lichess/seek', { limit: 600, increment: 5 })).status, 409, 'one wait at a time');

  // Paired: Lichess ends the seek stream and announces the game.
  await until(() => fake.seeks.size === 1);
  for (const res of fake.seeks) res.end();
  startGame('game0001');
  await until(() => events.some(([n, d]) => n === 'lichess:gameStart' && d.id === 'game0001'));
  await until(async () => !(await a.get('/api/lichess')).body.seeking);

  let game = (await a.get('/api/lichess/games/game0001')).body.game;
  game = game.loading ? await until(() => events.findLast(([n, d]) => n === 'lichess:game' && d.id === 'game0001' && !d.loading)?.[1]) : game;
  assert.equal(game.myColor, 'white');
  assert.equal(game.white.rating, 1650);
  assert.equal(game.black.name, 'Bob');

  assert.equal((await a.post('/api/lichess/games/game0001/move', { uci: 'e2e4' })).status, 200);
  const g = fake.games.get('game0001');
  g.moves.push('e7e5');
  pushState(g);
  const after2 = await until(() => events.findLast(([n, d]) => n === 'lichess:game' && d.moves?.length === 2)?.[1]);
  assert.deepEqual(after2.moves, ['e4', 'e5']);
  assert.equal((await a.post('/api/lichess/games/game0001/move', { uci: 'zz' })).status, 400);

  // Clubmates can watch: the game is listed with the club's live games and streams to spectators.
  const b = client();
  await b.post('/api/register', { username: 'clubbob', password: 'secret123' });
  await b.post(`/api/clubs/${club.id}/join`);
  const outsider = client();
  await outsider.post('/api/register', { username: 'outsider', password: 'secret123' });
  const listed = (await b.get(`/api/clubs/${club.id}/games`)).body.active.find((x) => x.source === 'lichess');
  assert.deepEqual([listed.href, listed.member.username, listed.white.name, listed.moves.length, listed.clock.running], ['#/lichess/game0001', 'clubalice', 'Alice', 2, 'w']);
  const watched = (await b.get('/api/lichess/games/game0001')).body.game;
  assert.deepEqual([watched.myColor, watched.owner.username, watched.importedId], [null, 'clubalice', null]);
  assert.equal((await outsider.get('/api/lichess/games/game0001')).status, 404);
  assert.equal((await b.post('/api/lichess/games/game0001/resign')).status, 409, "spectators can't act");
  const bSocket = ioClient(base, { extraHeaders: { Cookie: b.cookie }, transports: ['websocket'] });
  const oSocket = ioClient(base, { extraHeaders: { Cookie: outsider.cookie }, transports: ['websocket'] });
  const bEvents = [];
  const oEvents = [];
  bSocket.on('lichess:game', (d) => bEvents.push(d));
  oSocket.on('lichess:game', (d) => oEvents.push(d));
  await Promise.all([new Promise((r) => bSocket.on('connect', r)), new Promise((r) => oSocket.on('connect', r))]);
  bSocket.emit('watch:lichess', 'game0001');
  oSocket.emit('watch:lichess', 'game0001');
  await wait(100);
  g.moves.push('g1f3', 'b8c6');
  pushState(g);
  const seen = await until(() => bEvents.find((d) => d.moves?.length === 4));
  assert.equal(seen.myColor, null);
  assert.equal(oEvents.length, 0, 'outsiders get nothing');
  // Turning sharing off hides it.
  await a.post('/api/lichess/sharing', { share: false });
  assert.equal((await b.get(`/api/clubs/${club.id}/games`)).body.active.filter((x) => x.source === 'lichess').length, 0);
  assert.equal((await b.get('/api/lichess/games/game0001')).status, 404);
  assert.equal((await a.get(`/api/users/${user.id}`)).body.lichess.shareInClub, false);
  await a.post('/api/lichess/sharing', { share: true });
  bSocket.close();
  oSocket.close();

  // Resigning finishes the game; it's imported privately for review, without club rating changes.
  await a.post('/api/lichess/games/game0001/resign');
  const done = await until(() => events.findLast(([n, d]) => n === 'lichess:game' && d.finished && d.importedId)?.[1]);
  assert.equal(done.status, 'resign');
  const imported = (await a.get(`/api/games/${done.importedId}`)).body.game;
  assert.deepEqual([imported.mode, imported.visibility, imported.result, imported.meta.playerColor, imported.meta.lichess.id], ['import', 'private', '0-1', 'white', 'game0001']);
  assert.deepEqual(imported.moves, ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal((await a.get(`/api/users/${user.id}`)).body.clubs[0].rating, 1200);
  // Lichess reports our rating change in the finish event; it shows on the board and in the import.
  for (const res of fake.eventStreams) send(res, { type: 'gameFinish', game: { gameId: 'game0001', fullId: 'game0001abcd', ratingDiff: -7 } });
  const rated = await until(() => events.findLast(([n, d]) => n === 'lichess:game' && d.white?.ratingDiff === -7)?.[1]);
  assert.equal(rated.white.ratingDiff, -7);
  await until(async () => (await a.get(`/api/games/${done.importedId}`)).body.game.meta.lichess.whiteRatingDiff === -7);

  // Challenges: a direct challenge (blitz allowed), declined; an incoming one accepted; the computer.
  assert.equal((await a.post('/api/lichess/challenge', { username: 'nobody', limit: 300, increment: 3 })).body.error, 'Lichess: User not found');
  assert.equal((await a.post('/api/lichess/challenge', { username: 'Bob', limit: 300, increment: 3, color: 'black' })).status, 202);
  assert.deepEqual([fake.lastChallenge['clock.limit'], fake.lastChallenge.color, fake.lastChallenge.keepAliveStream], ['300', 'black', 'true']);
  const out = fake.challengeStreams.get('out1');
  send(out, { done: 'declined' });
  out.end();
  await until(() => events.some(([n, d]) => n === 'lichess:notice' && /declined/.test(d.message)));
  await until(async () => !(await a.get('/api/lichess')).body.outgoing);

  const incoming = { id: 'in1', status: 'created', challenger: { id: 'bob', name: 'Bob', rating: 1700 }, destUser: { id: ME.id, name: ME.username }, timeControl: { type: 'clock', limit: 600, increment: 0, show: '10+0' }, rated: false, speed: 'rapid', color: 'random' };
  fake.challenges.set('in1', incoming);
  for (const res of fake.eventStreams) send(res, { type: 'challenge', challenge: incoming });
  const withChallenge = await until(async () => { const b = (await a.get('/api/lichess')).body; return b.challenges.length ? b : null; });
  assert.deepEqual(withChallenge.challenges[0], { id: 'in1', from: 'Bob', rating: 1700, rated: false, speed: 'rapid', timeControl: '10+0', color: 'random' });
  assert.equal((await a.post('/api/lichess/challenges/in1/accept')).status, 200);
  await until(() => events.some(([n, d]) => n === 'lichess:gameStart' && d.id === 'accepted1'));

  assert.equal((await a.post('/api/lichess/ai', { level: 9, limit: 600, increment: 0 })).status, 400);
  const ai = await a.post('/api/lichess/ai', { level: 3, limit: 600, increment: 0 });
  assert.deepEqual([ai.status, ai.body.gameId], [201, 'aigame01']);

  // Disconnecting revokes the token.
  await a.post('/api/lichess/disconnect');
  assert.ok(fake.revoked);
  assert.deepEqual((await a.get('/api/lichess')).body, { connected: false });
  socket.close();
});
