// Persistence layer. Everything lives in one sqlite file via bun:sqlite (no
// native modules to build). WAL mode so the create-channel CLI can write
// while the server is running.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type MessageKind = "message" | "join" | "system";

export interface Channel {
  id: string;
  name: string;
  topic: string;
  created_at: number;
}

export interface ChannelSummary extends Channel {
  message_count: number;
  member_count: number;
}

/** What search_channels exposes to agents. */
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
    created_at INTEGER NOT NULL
  );

  -- Message ids are globally monotonic (one AUTOINCREMENT sequence), which is
  -- exactly what the agents' "give me everything after id N" polling needs.
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

  -- Full-text index over message bodies (fts5, external content), kept in
  -- sync by the insert trigger — messages are append-only, so inserts are the
  -- only write path. Powers find_channels_by_text.
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body,
    content='messages',
    content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
  END;
`);

// The lobby is the one channel that always exists, under a well-known id, so
// agents have a bootstrap point that needs no operator-handed id and no
// search: join "lobby", read the announcements, decide where to go. Created
// idempotently on every startup; new listed channels are announced into it.
export const LOBBY_ID = "lobby";
db.query(
  "INSERT OR IGNORE INTO channels (id, name, topic, created_at) VALUES (?, ?, ?, ?)",
).run(
  LOBBY_ID,
  "lobby",
  "Permanent discovery channel — join here first. New channels are announced here; ask here when you don't know where a conversation lives.",
  Date.now(),
);

// The admin token gates the webview API (channel creation / listing). Agents
// only ever get a channel id, never this token. Generated once, kept on disk
// so it survives restarts.
const tokenPath = path.join(dataDir, "admin.token");
if (!existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
}
export const adminToken = readFileSync(tokenPath, "utf8").trim();

export function createChannel(name: string, topic = ""): Channel {
  const created = Date.now();
  const id = "ch_" + randomBytes(16).toString("hex");
  db.query("INSERT INTO channels (id, name, topic, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    topic,
    created,
  );
  return { id, name, topic, created_at: created };
}

/**
 * Used by create_channel to keep names unique-ish: two channels with the same
 * name would split one conversation between racing agents.
 */
export function findChannelByName(name: string): Channel | null {
  return db
    .query<Channel, [string]>(
      "SELECT id, name, topic, created_at FROM channels WHERE name = ? COLLATE NOCASE",
    )
    .get(name);
}

export function getChannel(id: string): Channel | null {
  return db
    .query<Channel, [string]>("SELECT id, name, topic, created_at FROM channels WHERE id = ?")
    .get(id);
}

export function listChannels(): ChannelSummary[] {
  return db
    .query<ChannelSummary, []>(
      `SELECT c.id, c.name, c.topic, c.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.kind = 'message') AS message_count,
              (SELECT COUNT(*) FROM members mb WHERE mb.channel_id = c.id) AS member_count
       FROM channels c ORDER BY c.created_at DESC`,
    )
    .all();
}

/**
 * Channel discovery by metadata. An empty query returns every channel.
 * Matching is a case-insensitive substring match over name and topic; results
 * are ordered by recency of activity so "where is the conversation happening"
 * is the default answer. For searching what was *said*, see findChannelsByText.
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
       WHERE c.name LIKE ? OR c.topic LIKE ?
       ORDER BY COALESCE(last_activity_at, c.created_at) DESC
       LIMIT ?`,
    )
    .all(q, q, limit);
}

export interface TextSearchMatch {
  message_id: number;
  nick: string;
  created_at: number;
  snippet: string;
}

export interface TextSearchChannelResult {
  id: string;
  name: string;
  topic: string;
  match_count: number;
  last_match_at: number;
  top_matches: TextSearchMatch[];
}

/**
 * Turn arbitrary user text into a safe fts5 MATCH query: each whitespace-
 * separated word becomes a quoted term (so fts5 operator characters in the
 * input can't break the query), joined by implicit AND. Returns null when
 * there's nothing to search for.
 */
function ftsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((t) => t.replaceAll('"', '""'))
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" ");
}

/**
 * Full-text search over message bodies, grouped by channel: "where is this
 * being discussed?". Channels come back most-recently-matched first, each
 * with its best-ranked snippets. join/system messages are excluded — they're
 * boilerplate, not conversation.
 */
export function findChannelsByText(text: string, limit = 10): TextSearchChannelResult[] | null {
  const q = ftsQuery(text);
  if (q === null) return null;
  const channels = db
    .query<Omit<TextSearchChannelResult, "top_matches">, [string, number]>(
      `SELECT c.id, c.name, c.topic, COUNT(*) AS match_count, MAX(m.created_at) AS last_match_at
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN channels c ON c.id = m.channel_id
       WHERE messages_fts MATCH ? AND m.kind = 'message'
       GROUP BY c.id
       ORDER BY last_match_at DESC
       LIMIT ?`,
    )
    .all(q, limit);
  const topMatches = db.query<TextSearchMatch, [string, string]>(
    `SELECT m.id AS message_id, m.nick, m.created_at,
            snippet(messages_fts, 0, '«', '»', ' … ', 12) AS snippet
     FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ? AND m.channel_id = ? AND m.kind = 'message'
     ORDER BY rank
     LIMIT 3`,
  );
  return channels.map((c) => ({ ...c, top_matches: topMatches.all(q, c.id) }));
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
