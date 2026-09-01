// Versioned schema migrations over sqlite's built-in PRAGMA user_version.
//
// Rules:
// - NEVER edit or reorder an existing migration — append a new one. Databases
//   in the wild remember only how many migrations they've applied; changing
//   history silently desynchronizes them.
// - Migration 1 (baseline) is written idempotently (IF NOT EXISTS everywhere)
//   so databases created before this mechanism existed — when the schema was
//   applied inline at startup — are adopted in place: their tables already
//   exist, the baseline no-ops, and they get stamped like everyone else.
//   (Column-level drift from pre-baseline eras is not handled; those dbs
//   predate the project being shared and can be deleted.)
// - Each migration runs in its own transaction and bumps user_version inside
//   that same transaction, so a failed migration leaves the db untouched and
//   the next start retries it.
import type { Database } from "bun:sqlite";

interface Migration {
  name: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    name: "baseline",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          topic      TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );

        -- Message ids are globally monotonic (one AUTOINCREMENT sequence),
        -- which is exactly what the agents' "give me everything after id N"
        -- polling needs.
        CREATE TABLE IF NOT EXISTS messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          nick       TEXT NOT NULL,
          kind       TEXT NOT NULL DEFAULT 'message', -- 'message' | 'join' | 'system'
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

        CREATE TABLE IF NOT EXISTS members (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          nick       TEXT NOT NULL,
          joined_at  INTEGER NOT NULL,
          PRIMARY KEY (channel_id, nick)
        );

        -- Channel tags: an enumerable, exact-match vocabulary for correlating
        -- channels ("all channels about k8s"), complementing fuzzy name/topic
        -- search. Stored normalized (see normalizeTags in db.ts).
        CREATE TABLE IF NOT EXISTS channel_tags (
          channel_id TEXT NOT NULL REFERENCES channels(id),
          tag        TEXT NOT NULL,
          PRIMARY KEY (channel_id, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_tags_tag ON channel_tags(tag);

        -- Full-text index over message bodies (fts5, external content), kept
        -- in sync by the insert trigger — messages are append-only, so inserts
        -- are the only write path. Powers find_channels_by_text and
        -- search_messages.
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          body,
          content='messages',
          content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
        END;
      `);
    },
  },
  {
    name: "meta",
    up: (db) => {
      // Small key/value store for server bookkeeping that isn't chat data —
      // e.g. the hash of the MOTD last posted to the lobby.
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `ircmcp db: schema version ${current} is newer than this build understands ` +
        `(${MIGRATIONS.length}) — update ircmcp or use a fresh IRCMCP_DATA_DIR`,
    );
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]!;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    console.log(`ircmcp db: applied migration ${i + 1}/${MIGRATIONS.length} (${migration.name})`);
  }
}
