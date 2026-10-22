import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/app.js';

let server;
let base;
before(async () => {
  ({ server } = createServer({ dbFile: ':memory:' })); // rate limits on
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), get cookie() { return cookie; } };
}

test('failed logins are rate limited per account', async () => {
  const a = client();
  assert.equal((await a.post('/api/register', { username: 'limited', password: 'secret123' })).status, 201);
  const attacker = client();
  for (let i = 0; i < 8; i++) assert.equal((await attacker.post('/api/login', { username: 'limited', password: 'wrong!!' })).status, 401);
  const blocked = await attacker.post('/api/login', { username: 'limited', password: 'secret123' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Try again in \d+ minute/);
});

test('cookies are marked Secure behind an HTTPS proxy', async () => {
  const c = client();
  const r = await c.post('/api/register', { username: 'proxied', password: 'secret123' }, { 'X-Forwarded-Proto': 'https' });
  assert.match(r.setCookie, /Secure/i);
  const plain = await client().post('/api/register', { username: 'plainhttp', password: 'secret123' });
  assert.doesNotMatch(plain.setCookie, /Secure/i);
});

test('owner reset links, password change and session sign-out', async () => {
  const owner = client();
  await owner.post('/api/register', { username: 'clubowner', password: 'secret123' });
  const member = client();
  const m = (await member.post('/api/register', { username: 'forgetful', password: 'oldpass1' })).body.user;
  const club = (await owner.post('/api/clubs', { name: 'Reset Club' })).body.club;
  await member.post(`/api/clubs/${club.id}/join`);

  assert.equal((await member.post(`/api/clubs/${club.id}/members/${m.id}/reset-link`)).status, 403);
  const link = await owner.post(`/api/clubs/${club.id}/members/${m.id}/reset-link`);
  assert.equal(link.status, 201);
  const token = link.body.path.split('/').pop();

  assert.equal((await client().get(`/api/reset/${token}`)).body.username, 'forgetful');
  const fresh = client();
  assert.equal((await fresh.post(`/api/reset/${token}`, { password: 'newpass1' })).status, 200);
  assert.equal((await fresh.get('/api/clubs')).status, 200); // logged in by the reset
  assert.equal((await member.get('/api/clubs')).status, 401); // old session signed out
  assert.equal((await client().post(`/api/reset/${token}`, { password: 'again123' })).status, 404); // single use
  assert.equal((await client().post('/api/login', { username: 'forgetful', password: 'newpass1' })).status, 200);

  // Changing your own password keeps this session and needs the current password.
  assert.equal((await fresh.post('/api/me/password', { current: 'nope', password: 'another1' })).status, 403);
  assert.equal((await fresh.post('/api/me/password', { current: 'newpass1', password: 'another1' })).status, 200);
  assert.equal((await fresh.get('/api/clubs')).status, 200);

  // Owners can't reset other owners.
  const other = client();
  const o = (await other.post('/api/register', { username: 'otherowner', password: 'secret123' })).body.user;
  await other.post('/api/clubs', { name: 'Their club' });
  await other.post(`/api/clubs/${club.id}/join`);
  assert.equal((await owner.post(`/api/clubs/${club.id}/members/${o.id}/reset-link`)).status, 403);
});
