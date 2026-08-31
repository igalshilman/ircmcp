// Persistence layer. Everything lives in one sqlite file via bun:sqlite (no
// native modules to build). WAL mode so the create-channel CLI can write
// while the server is running.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type MessageKind = "message" | "join";

export interface Channel {
  id: string;
  name: string;
  topic: string;
  listed: number; // sqlite boolean: 1 = discoverable via search, 0 = join-by-id only
  created_at: number;
}

export interface ChannelSummary extends Channel {
  message_count: number;
  member_count: number;
}

/** What search_channels exposes to agents — listed channels only. */
export interface ChannelSearchResult {
  id: string;
  name: string;
  topic: string;
  member_count: number;
  message_count: number;
  last_activity_at: number | null;
}

export interface Message {
  id: number;
  channel_id: string;
  nick: string;
  kind: MessageKind;
  body: string;
  created_at: number;
}

export interface Member {
  nick: string;
  joined_at: number;
}

const projectRoot = path.resolve(import.meta.dir, "..");
export const dataDir = process.env.IRCMCP_DATA_DIR ?? path.join(projectRoot, "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "ircmcp.db"), { create: true });

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    topic      TEXT NOT NULL DEFAULT '',
    listed     INTEGER NOT NULL DEFAULT 1, -- 1 = discoverable via search_channels
    created_at INTEGER NOT NULL
  );

  -- Message ids are globally monotonic (one AUTOINCREMENT sequence), which is
  -- exactly what the agents' "give me everything after id N" polling needs.
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    nick       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'message', -- 'message' | 'join'
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
`);

// Migration for databases created before topic/listed existed. Old channels
// become listed — they predate the distinction and hiding them would silently
// break discovery of channels the operator already handed out.
{
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(channels)")
    .all()
    .map((c) => c.name);
  if (!cols.includes("topic")) db.exec("ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
  if (!cols.includes("listed")) db.exec("ALTER TABLE channels ADD COLUMN listed INTEGER NOT NULL DEFAULT 1");
}

// The admin token gates the webview API (channel creation / listing). Agents
// only ever get a channel id, never this token. Generated once, kept on disk
// so it survives restarts.
const tokenPath = path.join(dataDir, "admin.token");
if (!existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
}
export const adminToken = readFileSync(tokenPath, "utf8").trim();

export function createChannel(name: string, topic = "", listed = true): Channel {
  const created = Date.now();
  const id = "ch_" + randomBytes(16).toString("hex");
  db.query("INSERT INTO channels (id, name, topic, listed, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    topic,
    listed ? 1 : 0,
    created,
  );
  return { id, name, topic, listed: listed ? 1 : 0, created_at: created };
}

export function getChannel(id: string): Channel | null {
  return db
    .query<Channel, [string]>("SELECT id, name, topic, listed, created_at FROM channels WHERE id = ?")
    .get(id);
}

export function listChannels(): ChannelSummary[] {
  return db
    .query<ChannelSummary, []>(
      `SELECT c.id, c.name, c.topic, c.listed, c.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.kind = 'message') AS message_count,
              (SELECT COUNT(*) FROM members mb WHERE mb.channel_id = c.id) AS member_count
       FROM channels c ORDER BY c.created_at DESC`,
    )
    .all();
}

/**
 * Channel discovery for agents. Only listed channels are visible; unlisted
 * ones stay join-by-id-only no matter what the query is. An empty query
 * returns every listed channel. Matching is a case-insensitive substring
 * match over name and topic; results are ordered by recency of activity so
 * "where is the conversation happening" is the default answer.
 */
export function searchChannels(query = "", limit = 25): ChannelSearchResult[] {
  const q = `%${query.trim()}%`;
  return db
    .query<ChannelSearchResult, [string, string, number]>(
      `SELECT c.id, c.name, c.topic,
              (SELECT COUNT(*) FROM members mb WHERE mb.channel_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.kind = 'message') AS message_count,
              (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id) AS last_activity_at
       FROM channels c
       WHERE c.listed = 1 AND (c.name LIKE ? OR c.topic LIKE ?)
       ORDER BY COALESCE(last_activity_at, c.created_at) DESC
       LIMIT ?`,
    )
    .all(q, q, limit);
}

/** Returns true if the nick was new to the channel. */
export function joinChannel(channelId: string, nick: string): boolean {
  const res = db
    .query("INSERT OR IGNORE INTO members (channel_id, nick, joined_at) VALUES (?, ?, ?)")
    .run(channelId, nick, Date.now());
  return res.changes > 0;
}

export function listMembers(channelId: string): Member[] {
  return db
    .query<Member, [string]>("SELECT nick, joined_at FROM members WHERE channel_id = ? ORDER BY joined_at")
    .all(channelId);
}

export function postMessage(
  channelId: string,
  nick: string,
  body: string,
  kind: MessageKind = "message",
): Message {
  const created = Date.now();
  const res = db
    .query("INSERT INTO messages (channel_id, nick, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(channelId, nick, kind, body, created);
  return { id: Number(res.lastInsertRowid), channel_id: channelId, nick, kind, body, created_at: created };
}

export function getMessages(channelId: string, afterId = 0, limit = 100): Message[] {
  return db
    .query<Message, [string, number, number]>(
      "SELECT id, channel_id, nick, kind, body, created_at FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
    )
    .all(channelId, afterId, limit);
}

export function lastMessageId(channelId: string): number {
  const row = db
    .query<{ last: number }, [string]>(
      "SELECT COALESCE(MAX(id), 0) AS last FROM messages WHERE channel_id = ?",
    )
    .get(channelId);
  return Number(row?.last ?? 0);
}
