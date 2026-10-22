// In-memory sliding-window limiter for failed attempts (login, password reset links, sign-ups).

export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key → timestamps of recent failures

  function recent(key, now) {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    /** Milliseconds until `key` may try again, or 0 if it isn't blocked. */
    blockedFor(key, now = Date.now()) {
      const list = recent(key, now);
      return list.length >= max ? windowMs - (now - list[0]) : 0;
    },
    fail(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
