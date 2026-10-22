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

    -- Every rated result, per player (two rows per game or tournament result).
    CREATE TABLE IF NOT EXISTS rating_history (
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER,
      pairing_id INTEGER,
      opponent_id INTEGER,
      result REAL NOT NULL,
      rating INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rating_history_player ON rating_history(club_id, user_id);

    -- Club tournaments. format: swiss | roundrobin; play: online (games created automatically) | otb.
    -- status: registration | running | finished. schedule: round-robin pairings fixed at the start (JSON).
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      play TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      time_control TEXT,
      rated INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'registration',
      current_round INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tournament_players (
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      withdrawn INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tournament_id, user_id)
    );
    -- black_id NULL = bye. result: 1-0 | 0-1 | 1/2-1/2 | NULL while unplayed.
    CREATE TABLE IF NOT EXISTS tournament_pairings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      board INTEGER NOT NULL,
      white_id INTEGER NOT NULL REFERENCES users(id),
      black_id INTEGER REFERENCES users(id),
      result TEXT,
      game_id INTEGER,
      reported_by INTEGER,
      rated INTEGER NOT NULL DEFAULT 0
    );

    -- Server settings (e.g. the generated Web Push keys).
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Web Push subscriptions, one per device that enabled notifications.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- One-time password reset links created by a club owner for a member (token stored hashed).
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);

  // Columns added after the first release; add them to existing databases.
  const gameColumns = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  const added = { time_control: 'TEXT', white_ms: 'INTEGER', black_ms: 'INTEGER', turn_started_at: 'INTEGER', analysis: 'TEXT' };
  for (const [name, type] of Object.entries(added)) {
    if (!gameColumns.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${type}`);
  }
  const memberColumns = new Set(db.prepare('PRAGMA table_info(memberships)').all().map((c) => c.name));
  if (!memberColumns.has('rating')) db.exec('ALTER TABLE memberships ADD COLUMN rating INTEGER NOT NULL DEFAULT 1200');
  if (!memberColumns.has('rated_games')) db.exec('ALTER TABLE memberships ADD COLUMN rated_games INTEGER NOT NULL DEFAULT 0');
  return db;
}
