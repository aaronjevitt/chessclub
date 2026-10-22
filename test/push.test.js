import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../server/app.js';

let server;
let db;
let base;
const sent = [];
let failNext = null;

before(async () => {
  const pushSend = async (subscription, payload) => {
    if (failNext) {
      const err = Object.assign(new Error('gone'), { statusCode: failNext });
      failNext = null;
      throw err;
    }
    sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
  };
  ({ server, db } = createServer({ dbFile: ':memory:', rateLimits: false, pushSend }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

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
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), get cookie() { return cookie; } };
}

async function registered(name) {
  const c = client();
  const r = await c.post('/api/register', { username: name, password: 'secret123' });
  c.user = r.body.user;
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const sub = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'k', auth: 'a' } });

test('push: subscribe, your-move pushes only when not watching, gone subscriptions dropped', async () => {
  const a = await registered('pusha');
  const b = await registered('pushb');
  assert.ok((await a.get('/api/push/key')).body.publicKey.length > 40);
  assert.equal((await a.post('/api/push/subscribe', { subscription: { endpoint: 'http://insecure' } })).status, 400);
  assert.equal((await b.post('/api/push/subscribe', { subscription: sub('b') })).status, 201);
  assert.equal((await a.post('/api/push/subscribe', { subscription: sub('a') })).status, 201);

  const club = (await a.post('/api/clubs', { name: 'Push club' })).body.club;
  await b.post(`/api/clubs/${club.id}/join`);

  // A direct challenge notifies the invited player.
  const g = (await a.post(`/api/clubs/${club.id}/games`, { mode: 'online', color: 'white', opponentId: b.user.id })).body.game;
  await settle();
  assert.equal(sent.at(-1).title, 'New challenge');
  assert.equal(sent.at(-1).endpoint, sub('b').endpoint);

  await b.post(`/api/games/${g.id}/accept`);
  await settle();
  assert.equal(sent.at(-1).title, 'Challenge accepted');
  assert.equal(sent.at(-1).endpoint, sub('a').endpoint);

  await a.post(`/api/games/${g.id}/move`, { san: 'e4' });
  await settle();
  assert.deepEqual([sent.at(-1).title, sent.at(-1).body, sent.at(-1).url], ['Your move', 'pusha played e4', `/#/game/${g.id}`]);

  // While A has the game open, no push for B's reply.
  const socket = ioClient(base, { extraHeaders: { Cookie: a.cookie }, transports: ['websocket'] });
  await new Promise((resolve) => socket.emit('watch:game', g.id, resolve));
  const count = sent.length;
  await b.post(`/api/games/${g.id}/move`, { san: 'e5' });
  await settle();
  assert.equal(sent.length, count);
  socket.close();
  await settle();

  // A gone subscription is removed.
  failNext = 410;
  await a.post(`/api/games/${g.id}/move`, { san: 'Nf3' });
  await settle();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(b.user.id).n, 0);

  assert.equal((await a.post('/api/push/unsubscribe', { endpoint: sub('a').endpoint })).status, 200);
  assert.equal((await a.post('/api/push/test')).body.sent, 0);
});
