// Web Push notifications ("your move", challenges, tournament pairings). Keys are generated on first
// start and kept in the database; no third-party service account is needed.
import webpush from 'web-push';

export function createPush({ db, io, send = null }) {
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const subsOf = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
  const upsert = db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`);
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const removeForUser = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?');

  let keys = getSetting.get('vapid') ? JSON.parse(getSetting.get('vapid').value) : null;
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    setSetting.run('vapid', JSON.stringify(keys));
  }
  // Push services want a contact for the sender; Apple rejects placeholder addresses, so by default use
  // the site's own https URL (remembered from the first subscription).
  const subject = () => process.env.PUSH_SUBJECT || getSetting.get('push_subject')?.value || 'https://example.com';
  const deliver = send || ((subscription, payload) => webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 60 * 60,
  }));

  /** Is the user looking at the app right now (optionally: at a particular game)? */
  async function isActive(userId, room = null) {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    return room ? sockets.some((s) => s.rooms.has(room)) : sockets.length > 0;
  }

  /**
   * Notify every device of a user. With `unlessWatching` the push is skipped if the user has that room
   * open (e.g. the game page); with `unlessOnline` it is skipped if they have the app open at all.
   */
  async function notifyUser(userId, { title, body, url, tag }, { unlessWatching = null, unlessOnline = false } = {}) {
    if (!userId) return 0;
    if (unlessOnline && await isActive(userId)) return 0;
    if (unlessWatching && await isActive(userId, unlessWatching)) return 0;
    let sent = 0;
    const payload = JSON.stringify({ title, body, url, tag });
    for (const sub of subsOf.all(userId)) {
      try {
        await deliver({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (err) {
        // Gone or invalid: the browser unsubscribed or the app was removed.
        if ([404, 410].includes(err.statusCode)) remove.run(sub.endpoint);
        else console.error('Push failed:', err.statusCode || err.message);
      }
    }
    return sent;
  }

  function registerRoutes({ app, HttpError }) {
    app.get('/api/push/key', (_req, res) => res.json({ publicKey: keys.publicKey }));
    app.post('/api/push/subscribe', (req, res) => {
      const sub = req.body?.subscription;
      const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !sub.keys?.p256dh || !sub.keys?.auth) {
        throw new HttpError(400, 'Invalid push subscription');
      }
      const origin = `${req.protocol}://${req.get('host')}`;
      if (req.protocol === 'https' && !getSetting.get('push_subject')) setSetting.run('push_subject', origin);
      upsert.run(endpoint, req.user.id, String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), Date.now());
      res.status(201).json({ ok: true });
    });
    app.post('/api/push/unsubscribe', (req, res) => {
      removeForUser.run(String(req.body?.endpoint || ''), req.user.id);
      res.json({ ok: true });
    });
    app.post('/api/push/test', async (req, res) => {
      const sent = await notifyUser(req.user.id, { title: 'Chess Club', body: 'Notifications are working ♞', url: '/#/', tag: 'test' });
      res.json({ sent });
    });
  }

  return { notifyUser, registerRoutes, publicKey: keys.publicKey };
}
