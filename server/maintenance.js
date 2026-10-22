// Background upkeep: daily database backups and clean-up of games nobody will finish.
import fs from 'node:fs';
import path from 'node:path';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SWEEP_RULES = {
  // A timed online game whose clocks never started (no first moves) is aborted after 10 minutes.
  unstartedTimedMs: 10 * MINUTE,
  // A broadcast that was paused and never resumed is closed after a day.
  pausedBroadcastMs: 24 * HOUR,
  // Open challenges nobody accepted expire after a week.
  waitingChallengeMs: 7 * 24 * HOUR,
};

export function createMaintenance({ db, dbFile, notify, backupDir, keep = 14, backups = true }) {
  const dir = backupDir || path.join(path.dirname(dbFile), 'backups');
  const canBackup = backups && dbFile !== ':memory:';
  let timers = [];

  const findUnstarted = db.prepare(`SELECT id FROM games WHERE status = 'active' AND mode = 'online'
    AND time_control IS NOT NULL AND turn_started_at IS NULL AND updated_at < ?`);
  const findPaused = db.prepare("SELECT id FROM games WHERE status = 'paused' AND updated_at < ?");
  const findWaiting = db.prepare("SELECT id FROM games WHERE status = 'waiting' AND updated_at < ?");
  const abort = db.prepare("UPDATE games SET status = 'aborted', termination = ?, draw_offer_by = NULL, updated_at = ? WHERE id = ?");

  /** Abort games that will never be finished. Returns the ids changed. */
  function sweep(now = Date.now()) {
    const changed = [];
    const close = (rows, termination) => {
      for (const { id } of rows) {
        abort.run(termination, now, id);
        changed.push(id);
      }
    };
    close(findUnstarted.all(now - SWEEP_RULES.unstartedTimedMs), 'aborted — the game never started');
    close(findPaused.all(now - SWEEP_RULES.pausedBroadcastMs), 'broadcast stopped');
    close(findWaiting.all(now - SWEEP_RULES.waitingChallengeMs), 'expired');
    for (const id of changed) notify(id);
    return changed;
  }

  const backupName = (date) => `chessclub-${date.toISOString().slice(0, 10)}.db`;

  /** Write today's backup (a consistent copy via VACUUM INTO) and keep the newest `keep` files. */
  function backupNow(date = new Date()) {
    if (!canBackup) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, backupName(date));
    if (fs.existsSync(file)) fs.rmSync(file);
    db.prepare('VACUUM INTO ?').run(file);
    const old = fs.readdirSync(dir).filter((f) => /^chessclub-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) fs.rmSync(path.join(dir, f));
    return file;
  }

  function backupIfDue() {
    if (canBackup && !fs.existsSync(path.join(dir, backupName(new Date())))) {
      try {
        backupNow();
      } catch (err) {
        console.error('Backup failed:', err.message);
      }
    }
  }

  return {
    sweep,
    backupNow,
    backupDir: dir,
    start() {
      backupIfDue();
      sweep();
      timers = [setInterval(sweep, MINUTE), setInterval(backupIfDue, HOUR)];
      for (const t of timers) t.unref?.();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  };
}
