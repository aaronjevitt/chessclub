import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id),
      is_public INTEGER NOT NULL DEFAULT 1,
      invite_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (club_id, user_id)
    );

    -- mode: online (member vs member), computer, self, otb (over-the-board / real game)
    -- visibility: club (shown in club view) or private (participants only)
    -- status: waiting (open challenge), active, finished, aborted
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'club',
      status TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      white_id INTEGER REFERENCES users(id),
      black_id INTEGER REFERENCES users(id),
      white_name TEXT,
      black_name TEXT,
      creator_color TEXT,
      invited_id INTEGER REFERENCES users(id),
      start_fen TEXT NOT NULL,
      fen TEXT NOT NULL,
      moves TEXT NOT NULL DEFAULT '[]',
      result TEXT NOT NULL DEFAULT '*',
      termination TEXT,
      draw_offer_by INTEGER,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_club_status ON games(club_id, status);
  `);

  // Columns added after the first release; add them to existing databases.
  const gameColumns = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  const added = { time_control: 'TEXT', white_ms: 'INTEGER', black_ms: 'INTEGER', turn_started_at: 'INTEGER' };
  for (const [name, type] of Object.entries(added)) {
    if (!gameColumns.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
  }
  return db;
}
