import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server/app.js';

test('daily backups are consistent copies and old ones are pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessclub-backup-'));
  const { server, maintenance, db } = createServer({ dbFile: path.join(dir, 'club.db') });
  try {
    db.prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES ('backedup', 'x', 'y', 0)").run();
    const file = maintenance.backupNow(new Date('2026-01-20T12:00:00Z'));
    assert.ok(fs.existsSync(file));
    const copy = new DatabaseSync(file);
    assert.equal(copy.prepare("SELECT username FROM users WHERE username = 'backedup'").get().username, 'backedup');
    copy.close();
    for (let d = 1; d <= 20; d++) maintenance.backupNow(new Date(Date.UTC(2026, 1, d, 12)));
    const kept = fs.readdirSync(maintenance.backupDir).sort();
    // 14 newest kept (including the one made at startup today); the oldest test backups are pruned.
    assert.equal(kept.length, 14);
    assert.ok(kept.includes('chessclub-2026-02-20.db'));
    assert.ok(!kept.includes('chessclub-2026-01-20.db'));
    assert.ok(!kept.includes('chessclub-2026-02-01.db'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
