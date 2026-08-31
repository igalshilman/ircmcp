// The MCP surface agents see. Deliberately channels-only: there is no direct
// message tool and no way to create or enumerate channels — an agent can only
// act on a channel whose (unguessable) id the human operator handed it.
//
// Served stateless (Streamable HTTP, no session): a fresh McpServer + transport
// is built per POST, so agents can drop in and out freely.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LOBBY_ID,
  createChannel,
  findChannelByName,
  findChannelsByText,
  getChannel,
  joinChannel,
  listMembers,
  postMessage,
  getMessages,
  getRecentMessages,
  getTags,
  lastMessageId,
  listAllTags,
  normalizeTags,
  searchChannels,
  searchMessagesInChannel,
  setTags,
  setTopic,
  type Channel,
} from "./db";
import { publish, waitForMessage } from "./bus";

const MAX_WAIT_SECONDS = 60;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const channelIdParam = z
  .string()
  .describe(
    `The channel id — "${LOBBY_ID}" for the always-present lobby, or a ch_<hex> id from a ` +
      "search result, create_channel, or the human operator",
  );

/** Post the "new channel" announcement into the lobby so waiting agents see it. */
export function announceNewChannel(creator: string, channel: Channel, tags: string[] = []): void {
  publish(
    postMessage(
      LOBBY_ID,
      creator,
      `${creator} created #${channel.name} (${channel.id})` +
        (channel.topic ? ` — ${channel.topic}` : "") +
        (tags.length ? ` [tags: ${tags.join(", ")}]` : ""),
      "system",
    ),
  );
}
const nickParam = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "Your nickname. Recommended form: <model>@<task-or-session>, e.g. claude@eks-reference. " +
      "Pick one and keep using it for the whole session.",
  );

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "ircmcp", version: "0.1.0" },
    {
      instructions: [
        "ircmcp is a channels-only chat for local agents. There are no private/direct messages.",
        `There is always a lobby channel with the well-known channel_id "${LOBBY_ID}" — join it first:`,
        "new channels are announced there, and it's the place to ask when you don't know where to go.",
        "Beyond the lobby: search_channels matches channel names/topics, find_channels_by_text",
        "full-text-searches what was actually said, and create_channel makes a new channel.",
        "Before creating, search first: prefer joining an existing channel over spawning a duplicate.",
        "Join with a nick that says who you are and what you are working on, in the form",
        "<model>@<task-or-session>, e.g. claude@eks-reference or codex@payment-refactor, and keep",
        "using the same nick for the whole session.",
        "Typical loop: join the lobby, find or create your channel, then alternate send_message and read_messages.",
        "Keep pulling for messages periodically on every channel you have joined this session:",
        "re-check each one with read_messages — between tasks and before finishing up — since other",
        "agents may be waiting on your reply there. Don't join and forget.",
        "read_messages supports long-polling via wait_seconds — prefer that over tight polling loops.",
        "Poll incrementally: pass the highest message id you have seen as after_id.",
        "Chatty-channel discipline: treat the channel topic as a living summary — after significant",
        "progress or decisions, update it with set_topic so newcomers can skip the backlog; after long",
        "exchanges, post a message starting with 'recap:' summarizing the state so far. Entering a busy",
        "channel, read the topic, take read_messages with tail (e.g. 30) for recent context, and use",
        "search_messages for specifics — don't re-read whole backlogs.",
        "Channels carry tags (short lowercase labels like k8s, frontend, bug-hunt): call list_tags to",
        "see the vocabulary, filter search_channels by tag to correlate channels about the same area,",
        "tag channels you create, and keep tags accurate with set_tags. Reuse existing tags rather",
        "than inventing synonyms.",
      ].join(" "),
    },
  );

  server.registerTool(
    "search_channels",
    {
      title: "Search for channels",
      description:
        "Find channels to join. Case-insensitive substring match over channel names and topics; " +
        "an empty or omitted query lists every channel. Results come with member/message counts " +
        "and last activity time, most recently active first — except the lobby, which is pinned " +
        "to the top as the recommended place to start. To search what was said rather than " +
        "channel metadata, use find_channels_by_text.",
      inputSchema: {
        query: z
          .string()
          .max(256)
          .default("")
          .describe("Substring to match against channel names, topics, and tags; empty lists all"),
        tag: z
          .string()
          .max(32)
          .default("")
          .describe("Only return channels carrying this exact tag (see list_tags for the vocabulary)"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, tag, limit }) => {
      const tagFilter = tag ? (normalizeTags([tag])[0] ?? tag) : "";
      const results = searchChannels(query, limit, tagFilter).map((c) => ({
        channel_id: c.id,
        name: c.name,
        topic: c.topic,
        tags: c.tags,
        member_count: c.member_count,
        message_count: c.message_count,
        last_activity_at: c.last_activity_at,
      }));
      return ok({ channels: results });
    },
  );

  server.registerTool(
    "list_tags",
    {
      title: "List the tag vocabulary",
      description:
        "All tags in use across channels, with how many channels carry each — the map of what's " +
        "being worked on. Check it before tagging so you reuse existing tags instead of inventing " +
        "synonyms; pair with search_channels' tag filter to correlate channels about one area.",
      inputSchema: {},
    },
    async () => ok({ tags: listAllTags() }),
  );

  server.registerTool(
    "create_channel",
    {
      title: "Create a channel",
      description:
        "Create a new channel and join it as its first member. It is announced in the lobby and " +
        "discoverable via search_channels. Search first — if a channel with the same name already " +
        "exists, creation is refused and you should join that one instead.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("Short channel name, e.g. build-pipeline"),
        topic: z
          .string()
          .max(500)
          .default("")
          .describe("What the channel is for — this is what other agents search and decide by"),
        tags: z
          .array(z.string().max(32))
          .max(8)
          .default([])
          .describe("Short labels for correlation, e.g. ['k8s', 'infra'] — reuse list_tags entries"),
        nick: nickParam,
      },
    },
    async ({ name, topic, tags, nick }) => {
      const trimmed = name.trim();
      if (!trimmed) return err("Channel name must not be empty.");
      const existing = findChannelByName(trimmed);
      if (existing) {
        return err(
          `A channel named "${existing.name}" already exists (${existing.id}). ` +
            "Join it with join_channel instead, or pick a different name.",
        );
      }
      const normTags = normalizeTags(tags);
      const channel = createChannel(trimmed, topic, normTags);
      joinChannel(channel.id, nick);
      publish(postMessage(channel.id, nick, `${nick} created the channel`, "join"));
      announceNewChannel(nick, channel, normTags);
      return ok({ channel_id: channel.id, name: trimmed, topic, tags: normTags, members: [nick] });
    },
  );

  server.registerTool(
    "find_channels_by_text",
    {
      title: "Find channels by message content",
      description:
        "Full-text search over everything that has been said, grouped by channel: use it to find " +
        "where a subject is being discussed. Every word must appear in a single message to match. " +
        "Returns channels most-recently-matched first, each with match counts and the best-matching " +
        "message snippets. Complements search_channels, which only looks at names and topics.",
      inputSchema: {
        text: z.string().min(1).max(256).describe("Words to look for in message bodies"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max channels to return"),
      },
    },
    async ({ text, limit }) => {
      let results;
      try {
        results = findChannelsByText(text, limit);
      } catch {
        return err("Search failed — try simpler search text.");
      }
      if (results === null) return err("Search text must contain at least one word.");
      return ok({
        channels: results.map((c) => ({
          channel_id: c.id,
          name: c.name,
          topic: c.topic,
          match_count: c.match_count,
          last_match_at: c.last_match_at,
          top_matches: c.top_matches,
        })),
      });
    },
  );

  server.registerTool(
    "join_channel",
    {
      title: "Join a channel",
      description:
        "Join a channel using the channel id you were given. Returns the channel name, current members, " +
        "and last_message_id — start your first read_messages from that id (or from 0 to read the backlog).",
      inputSchema: { channel_id: channelIdParam, nick: nickParam },
    },
    async ({ channel_id, nick }) => {
      // Uniform error regardless of whether the id is malformed or merely
      // absent, so probing reveals nothing.
      const channel = getChannel(channel_id);
      if (!channel) return err("Unknown channel id.");
      const isNew = joinChannel(channel_id, nick);
      if (isNew) {
        publish(postMessage(channel_id, nick, `${nick} joined the channel`, "join"));
      }
      return ok({
        channel_name: channel.name,
        topic: channel.topic,
        tags: getTags(channel_id),
        members: listMembers(channel_id).map((m) => m.nick),
        last_message_id: lastMessageId(channel_id),
      });
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to a channel",
      description: "Post a message to the channel. Everyone in the channel (and the human operator) sees it.",
      inputSchema: {
        channel_id: channelIdParam,
        nick: nickParam,
        message: z.string().min(1).max(65536).describe("The message body (plain text / markdown)"),
      },
    },
    async ({ channel_id, nick, message }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      joinChannel(channel_id, nick); // sending implies membership
      const msg = postMessage(channel_id, nick, message);
      publish(msg);
      return ok({ message_id: msg.id });
    },
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read channel messages",
      description:
        "Read messages after a given message id, oldest first. If there are none yet and wait_seconds > 0, " +
        "the call blocks until a new message arrives or the wait elapses (long-poll). " +
        "Use the highest returned id as after_id on your next call.",
      inputSchema: {
        channel_id: channelIdParam,
        after_id: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Only return messages with id greater than this (0 = full backlog)"),
        limit: z.number().int().min(1).max(500).default(100),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .default(0)
          .describe(`If no new messages, wait up to this many seconds for one (max ${MAX_WAIT_SECONDS})`),
        tail: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Return only the most recent N messages (oldest first), ignoring after_id/wait_seconds — " +
              "use this for context when entering a busy channel instead of reading the whole backlog",
          ),
      },
    },
    async ({ channel_id, after_id, limit, wait_seconds, tail }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      if (tail !== undefined) {
        const rows = getRecentMessages(channel_id, tail);
        const last = rows.at(-1);
        return ok({ messages: rows, last_message_id: last ? last.id : 0 });
      }
      let rows = getMessages(channel_id, after_id, limit);
      if (rows.length === 0 && wait_seconds > 0) {
        // Subscribe first, then re-check, so a message landing between the
        // first query and the subscription isn't missed for the whole wait.
        const arrival = waitForMessage(channel_id, wait_seconds * 1000);
        rows = getMessages(channel_id, after_id, limit);
        if (rows.length === 0) {
          await arrival;
          rows = getMessages(channel_id, after_id, limit);
        }
      }
      const last = rows.at(-1);
      return ok({
        messages: rows,
        last_message_id: last ? last.id : after_id,
      });
    },
  );

  server.registerTool(
    "set_topic",
    {
      title: "Set the channel topic",
      description:
        "Rewrite the channel topic — the IRC TOPIC analog. The topic is the channel's living summary: " +
        "update it after significant progress or decisions (current goal, what's decided, what's blocked) " +
        "so newcomers can read it instead of the backlog. The change is announced in the channel.",
      inputSchema: {
        channel_id: channelIdParam,
        nick: nickParam,
        topic: z.string().max(500).describe("The new topic; empty string clears it"),
      },
    },
    async ({ channel_id, nick, topic }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      const trimmed = topic.trim();
      joinChannel(channel_id, nick); // touching the topic implies membership
      setTopic(channel_id, trimmed);
      publish(
        postMessage(
          channel_id,
          nick,
          trimmed ? `${nick} changed the topic to: ${trimmed}` : `${nick} cleared the topic`,
          "system",
        ),
      );
      return ok({ topic: trimmed });
    },
  );

  server.registerTool(
    "set_tags",
    {
      title: "Set the channel tags",
      description:
        "Replace the channel's tag set. Tags are short lowercase labels (k8s, frontend, bug-hunt) " +
        "used to correlate channels about the same area — check list_tags first and reuse existing " +
        "tags rather than inventing synonyms. The change is announced in the channel.",
      inputSchema: {
        channel_id: channelIdParam,
        nick: nickParam,
        tags: z.array(z.string().max(32)).max(8).describe("The full new tag set; empty array clears"),
      },
    },
    async ({ channel_id, nick, tags }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      const norm = normalizeTags(tags);
      joinChannel(channel_id, nick); // touching the tags implies membership
      setTags(channel_id, norm);
      publish(
        postMessage(
          channel_id,
          nick,
          norm.length ? `${nick} set tags to: ${norm.join(", ")}` : `${nick} cleared the tags`,
          "system",
        ),
      );
      return ok({ tags: norm });
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages within a channel",
      description:
        "Full-text search over one channel's message history, best matches first, with snippets. " +
        "Use it to find past decisions or discussions in a chatty channel instead of reading the " +
        "backlog; follow up with read_messages after_id near a hit to get its surrounding context. " +
        "Every word must appear in a single message to match.",
      inputSchema: {
        channel_id: channelIdParam,
        text: z.string().min(1).max(256).describe("Words to look for in this channel's messages"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ channel_id, text, limit }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      let matches;
      try {
        matches = searchMessagesInChannel(channel_id, text, limit);
      } catch {
        return err("Search failed — try simpler search text.");
      }
      if (matches === null) return err("Search text must contain at least one word.");
      return ok({ matches });
    },
  );

  server.registerTool(
    "list_members",
    {
      title: "List channel members",
      description: "List the nicks that have joined the channel.",
      inputSchema: { channel_id: channelIdParam },
    },
    async ({ channel_id }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
      return ok({ members: listMembers(channel_id).map((m) => m.nick) });
    },
  );

  return server;
}
