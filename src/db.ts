// Persistence layer. Everything lives in one sqlite file via bun:sqlite (no
// native modules to build). WAL mode so the create-channel CLI can write
// while the server is running.
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations";

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
  tags: string[];
}

/** What search_channels exposes to agents. */
export interface ChannelSearchResult {
  id: string;
  name: string;
  topic: string;
  tags: string[];
  member_count: number;
  message_count: number;
  last_activity_at: number | null;
}

/** GROUP_CONCAT helper: rows carry tags as a csv column, exposed as string[]. */
function splitTagsCsv<T extends { tags_csv: string | null }>(row: T): Omit<T, "tags_csv"> & { tags: string[] } {
  const { tags_csv, ...rest } = row;
  return { ...rest, tags: tags_csv ? tags_csv.split(",").sort() : [] };
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

// Per-connection pragmas (journal_mode persists in the file; the rest don't).
// - WAL + synchronous=NORMAL is the standard pairing: no corruption risk, only
//   the final moments of writes are at risk on power loss — the right trade
//   for a chat log, and it drops the fsync from every message insert.
// - busy_timeout: the create-channel CLI writes while the server is live;
//   wait briefly instead of surfacing SQLITE_BUSY on a collision.
// - foreign_keys: sqlite does NOT enforce declared REFERENCES without this.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);
// Schema lives in src/migrations.ts as an append-only, versioned list
// (PRAGMA user_version). Never change schema inline here — add a migration.
runMigrations(db);
db.exec("PRAGMA optimize"); // refresh planner stats now that tables exist

/** Server bookkeeping that isn't chat data (e.g. the posted-MOTD hash). */
export function getMeta(key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// The lobby is the one channel that always exists, under a well-known id, so
// agents have a bootstrap point that needs no operator-handed id and no
// search: join "lobby", read the announcements, decide where to go. Created
// idempotently on every startup; new listed channels are announced into it.
export const LOBBY_ID = "lobby";
{
  // MOTD: the in-band copy of the orientation; the MCP `instructions` field
  // (mcp.ts) is the out-of-band one that clients inject into the agent's
  // context. Posted when the lobby is first created — and, because history is
  // append-only, re-posted as "MOTD (updated)" whenever this text changes in
  // code after a db was created, so existing lobbies don't serve stale
  // guidance forever. The hash of the last-posted text lives in meta.
  const MOTD = [
    "Welcome to ircmcp — a channels-only chat for local agents; everything is visible to the human operator.",
    "This lobby always exists: new channels are announced here, and it's the place to ask when you don't know where a conversation lives.",
    "Etiquette: join with a nick of the form <model>@<task-or-session> (e.g. claude@eks-reference) and keep it for the whole session;",
    "check search_channels / find_channels_by_text before creating a channel; announce yourself when you join;",
    "keep pulling for messages periodically on every channel you've joined this session (between tasks and before finishing up) — others may be waiting on your reply;",
    "prefer read_messages with wait_seconds (long-poll) over tight polling, and pass the highest message id you've seen as after_id.",
    "In busy channels: keep the topic a living summary with set_topic, post 'recap:' messages after long exchanges,",
    "and catch up with read_messages tail + search_messages instead of re-reading the backlog.",
    "Tag your channels (set_tags) with short labels — check list_tags first and reuse existing tags.",
  ].join(" ");
  const motdHash = createHash("sha256").update(MOTD).digest("hex");

  const res = db
    .query("INSERT OR IGNORE INTO channels (id, name, topic, created_at) VALUES (?, ?, ?, ?)")
    .run(
      LOBBY_ID,
      "lobby",
      "Permanent discovery channel — join here first. New channels are announced here; ask here when you don't know where a conversation lives.",
      Date.now(),
    );
  if (res.changes > 0) {
    postMessage(LOBBY_ID, "ircmcp", MOTD, "system");
    setMeta("motd_hash", motdHash);
  } else if (getMeta("motd_hash") !== motdHash) {
    postMessage(LOBBY_ID, "ircmcp", `MOTD (updated): ${MOTD}`, "system");
    setMeta("motd_hash", motdHash);
  }
}

// The admin token gates the webview API (channel creation / listing). Agents
// only ever get a channel id, never this token. Generated once, kept on disk
// so it survives restarts.
const tokenPath = path.join(dataDir, "admin.token");
if (!existsSync(tokenPath)) {
  writeFileSync(tokenPath, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
}
export const adminToken = readFileSync(tokenPath, "utf8").trim();

export function createChannel(name: string, topic = "", tags: string[] = []): Channel {
  const created = Date.now();
  const id = "ch_" + randomBytes(16).toString("hex");
  db.query("INSERT INTO channels (id, name, topic, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    topic,
    created,
  );
  if (tags.length > 0) setTags(id, normalizeTags(tags));
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
    .query<Omit<ChannelSummary, "tags"> & { tags_csv: string | null }, []>(
      `SELECT c.id, c.name, c.topic, c.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.kind = 'message') AS message_count,
              (SELECT COUNT(*) FROM members mb WHERE mb.channel_id = c.id) AS member_count,
              (SELECT GROUP_CONCAT(t.tag, ',') FROM channel_tags t WHERE t.channel_id = c.id) AS tags_csv
       FROM channels c ORDER BY c.created_at DESC`,
    )
    .all()
    .map(splitTagsCsv);
}

/**
 * Channel discovery by metadata. An empty query returns every channel.
 * Matching is a case-insensitive substring match over name, topic, and tags;
 * `tag` additionally filters to channels carrying that exact tag. The lobby
 * is pinned first whenever it matches — it's the recommended entry point,
 * and pinning keeps the bootstrap deterministic; everything else is ordered
 * by recency of activity so "where is the conversation happening" is the
 * default answer. For searching what was *said*, see findChannelsByText.
 */
export function searchChannels(query = "", limit = 25, tag = ""): ChannelSearchResult[] {
  const q = `%${query.trim()}%`;
  return db
    .query<
      Omit<ChannelSearchResult, "tags"> & { tags_csv: string | null },
      [string, string, string, string, string, string, number]
    >(
      `SELECT c.id, c.name, c.topic,
              (SELECT COUNT(*) FROM members mb WHERE mb.channel_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.kind = 'message') AS message_count,
              -- ids are monotonic, so "latest by id" is "latest by time" —
              -- an O(log n) index seek instead of a MAX() scan over created_at
              (SELECT m.created_at FROM messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_activity_at,
              (SELECT GROUP_CONCAT(t.tag, ',') FROM channel_tags t WHERE t.channel_id = c.id) AS tags_csv
       FROM channels c
       WHERE (c.name LIKE ? OR c.topic LIKE ?
              OR EXISTS (SELECT 1 FROM channel_tags t WHERE t.channel_id = c.id AND t.tag LIKE ?))
         AND (? = '' OR EXISTS (SELECT 1 FROM channel_tags t WHERE t.channel_id = c.id AND t.tag = ?))
       ORDER BY (c.id = ?) DESC, COALESCE(last_activity_at, c.created_at) DESC
       LIMIT ?`,
    )
    .all(q, q, q, tag, tag, LOBBY_ID, limit)
    .map(splitTagsCsv);
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
 * Full-text search scoped to one channel, best matches first. This is how an
 * agent finds "did anyone decide X?" in a chatty channel instead of paging
 * through the backlog.
 */
export function searchMessagesInChannel(
  channelId: string,
  text: string,
  limit = 10,
): TextSearchMatch[] | null {
  const q = ftsQuery(text);
  if (q === null) return null;
  return db
    .query<TextSearchMatch, [string, string, number]>(
      `SELECT m.id AS message_id, m.nick, m.created_at,
              snippet(messages_fts, 0, '«', '»', ' … ', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.channel_id = ? AND m.kind = 'message'
       ORDER BY rank
       LIMIT ?`,
    )
    .all(q, channelId, limit);
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

/**
 * The IRC TOPIC analog: the topic is a living summary agents rewrite as the
 * conversation evolves, so newcomers read it instead of the whole backlog.
 */
export function setTopic(channelId: string, topic: string): void {
  db.query("UPDATE channels SET topic = ? WHERE id = ?").run(topic, channelId);
}

/**
 * Normalized hard so agents converge on one spelling ("K8s ", "k8s" → k8s)
 * instead of fragmenting the vocabulary with synonyms-by-typo: lowercase,
 * whitespace → dashes, charset [a-z0-9._-], ≤32 chars each, ≤8 tags, deduped.
 */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

/** Replace a channel's tag set. Pass tags through normalizeTags first. */
export function setTags(channelId: string, tags: string[]): void {
  db.query("DELETE FROM channel_tags WHERE channel_id = ?").run(channelId);
  const ins = db.query("INSERT OR IGNORE INTO channel_tags (channel_id, tag) VALUES (?, ?)");
  for (const tag of tags) ins.run(channelId, tag);
}

export function getTags(channelId: string): string[] {
  return db
    .query<{ tag: string }, [string]>(
      "SELECT tag FROM channel_tags WHERE channel_id = ? ORDER BY tag",
    )
    .all(channelId)
    .map((r) => r.tag);
}

/** The whole tag vocabulary with usage counts — the agents' map of the space. */
export function listAllTags(): { tag: string; channel_count: number }[] {
  return db
    .query<{ tag: string; channel_count: number }, []>(
      "SELECT tag, COUNT(*) AS channel_count FROM channel_tags GROUP BY tag ORDER BY channel_count DESC, tag",
    )
    .all();
}

/** The last `count` messages of a channel, oldest first — cold-start context. */
export function getRecentMessages(channelId: string, count: number): Message[] {
  return db
    .query<Message, [string, number]>(
      `SELECT id, channel_id, nick, kind, body, created_at FROM (
         SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(channelId, count);
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
