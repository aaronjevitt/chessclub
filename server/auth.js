import crypto from 'node:crypto';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function createAuth(db) {
  const insertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
  const findSession = db.prepare(`
    SELECT u.id, u.username, s.created_at AS session_created
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

  function createSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    insertSession.run(token, userId, Date.now());
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  function userFromCookieHeader(header) {
    const token = parseCookies(header)[SESSION_COOKIE];
    if (!token) return null;
    const row = findSession.get(token);
    if (!row) return null;
    if (Date.now() - row.session_created > SESSION_MAX_AGE_MS) {
      deleteSession.run(token);
      return null;
    }
    return { id: row.id, username: row.username };
  }

  function destroySession(req, res) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) deleteSession.run(token);
    res.clearCookie(SESSION_COOKIE);
  }

  function attachUser(req, _res, next) {
    req.user = userFromCookieHeader(req.headers.cookie);
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please log in' });
    next();
  }

  return { createSession, destroySession, userFromCookieHeader, attachUser, requireUser };
}
