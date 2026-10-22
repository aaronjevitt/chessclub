// Accounts: sign-up, login (rate limited), logout, password changes and owner-issued reset links.
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { createLimiter } from './ratelimit.js';

const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));

function readPassword(body, field = 'password') {
  return typeof body?.[field] === 'string' ? body[field] : '';
}

/** Routes that work without being logged in (registered before the auth guard). */
export function registerPublicAccountRoutes({ app, db, q, auth, HttpError, cleanText, rateLimits = true }) {
  // Failed logins: per account+address, and per address overall. Sign-ups and bad reset links: per address.
  const limit = (windowMs, max) => createLimiter({ windowMs, max: rateLimits ? max : Infinity });
  const loginLimiter = limit(15 * 60 * 1000, 8);
  const addressLimiter = limit(15 * 60 * 1000, 30);
  const signupLimiter = limit(60 * 60 * 1000, 10);
  const resetLimiter = limit(15 * 60 * 1000, 20);

  const findReset = db.prepare(`
    SELECT r.*, u.username FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`);
  const useReset = db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?');

  function guard(limiter, key, message) {
    const wait = limiter.blockedFor(key);
    if (wait) throw new HttpError(429, `${message} Try again in ${minutes(wait)} minute${minutes(wait) === 1 ? '' : 's'}.`);
  }

  app.post('/api/register', (req, res) => {
    guard(signupLimiter, req.ip, 'Too many new accounts from this network.');
    const username = cleanText(req.body?.username, 40);
    const password = readPassword(req.body);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers, _ or -');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (q.userByName.get(username)) throw new HttpError(409, 'That username is taken');
    const { hash, salt } = hashPassword(password);
    const { lastInsertRowid } = q.insertUser.run(username, hash, salt, Date.now());
    signupLimiter.fail(req.ip);
    auth.createSession(req, res, Number(lastInsertRowid));
    res.status(201).json({ user: { id: Number(lastInsertRowid), username } });
  });

  app.post('/api/login', (req, res) => {
    const username = cleanText(req.body?.username, 40);
    const password = readPassword(req.body);
    const accountKey = `${req.ip}|${username.toLowerCase()}`;
    guard(addressLimiter, req.ip, 'Too many failed logins.');
    guard(loginLimiter, accountKey, 'Too many failed logins for this account.');
    const row = q.userByName.get(username);
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      loginLimiter.fail(accountKey);
      addressLimiter.fail(req.ip);
      throw new HttpError(401, 'Invalid username or password');
    }
    loginLimiter.reset(accountKey);
    auth.createSession(req, res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: req.user });
  });

  function validReset(req) {
    guard(resetLimiter, req.ip, 'Too many invalid reset links.');
    const reset = findReset.get(hashToken(String(req.params.token)), Date.now());
    if (!reset) {
      resetLimiter.fail(req.ip);
      throw new HttpError(404, 'This reset link is invalid, already used, or has expired. Ask your club owner for a new one.');
    }
    return reset;
  }

  app.get('/api/reset/:token', (req, res) => {
    res.json({ username: validReset(req).username });
  });

  // Choosing a new password signs the account out everywhere else and logs this browser in.
  app.post('/api/reset/:token', (req, res) => {
    const reset = validReset(req);
    const password = readPassword(req.body);
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    const { hash, salt } = hashPassword(password);
    setPassword.run(hash, salt, reset.user_id);
    useReset.run(Date.now(), reset.token_hash);
    auth.destroyUserSessions(reset.user_id);
    auth.createSession(req, res, reset.user_id);
    res.json({ user: { id: reset.user_id, username: reset.username } });
  });
}

/** Routes for logged-in users (registered after the auth guard). */
export function registerAccountRoutes({ app, db, q, auth, HttpError }) {
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?');
  const ownsAnyClub = db.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1");
  const insertReset = db.prepare('INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)');
  const dropUnusedResets = db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL');

  // Change your own password; other sessions are signed out, this one stays.
  app.post('/api/me/password', (req, res) => {
    const row = userRow.get(req.user.id);
    if (!verifyPassword(readPassword(req.body, 'current'), row.salt, row.password_hash)) {
      throw new HttpError(403, 'Your current password is incorrect');
    }
    const password = readPassword(req.body);
    if (password.length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    const { hash, salt } = hashPassword(password);
    setPassword.run(hash, salt, req.user.id);
    auth.destroyUserSessions(req.user.id, auth.sessionToken(req));
    res.json({ ok: true });
  });

  // There's no email, so a club owner can issue a one-time reset link (valid 24 hours) for a member.
  app.post('/api/clubs/:id/members/:userId/reset-link', (req, res) => {
    const clubId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    if (q.membership.get(clubId, req.user.id)?.role !== 'owner') throw new HttpError(403, 'Only the club owner can create reset links');
    if (targetId === req.user.id) throw new HttpError(400, 'Change your own password from your account page');
    if (!q.membership.get(clubId, targetId)) throw new HttpError(404, 'That player is not in this club');
    if (ownsAnyClub.get(targetId)) throw new HttpError(403, "Club owners can't have their password reset by another owner");
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + RESET_TTL_MS;
    dropUnusedResets.run(targetId);
    insertReset.run(hashToken(token), targetId, req.user.id, expiresAt);
    res.status(201).json({ path: `/#/reset/${token}`, expiresAt });
  });
}
