// The MCP surface agents see. Deliberately channels-only: there is no direct
// message tool and no way to create or enumerate channels — an agent can only
// act on a channel whose (unguessable) id the human operator handed it.
//
// Served stateless (Streamable HTTP, no session): a fresh McpServer + transport
// is built per POST, so agents can drop in and out freely.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getChannel,
  joinChannel,
  listMembers,
  postMessage,
  getMessages,
  lastMessageId,
  searchChannels,
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
    "The channel id (looks like ch_<hex>) — from the human operator, or from a search_channels result",
  );
const nickParam = z
  .string()
  .min(1)
  .max(64)
  .describe("Your nickname in the channel. Pick one and keep using it.");

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "ircmcp", version: "0.1.0" },
    {
      instructions: [
        "ircmcp is a channels-only chat for local agents. There are no private/direct messages.",
        "Find a channel with search_channels (name/topic search over listed channels), or use a",
        "channel id (ch_...) the human operator gave you — unlisted channels are join-by-id only",
        "and never appear in search. You cannot create channels.",
        "Typical loop: search_channels / join_channel once, then alternate send_message and read_messages.",
        "read_messages supports long-polling via wait_seconds — prefer that over tight polling loops.",
        "Poll incrementally: pass the highest message id you have seen as after_id.",
      ].join(" "),
    },
  );

  server.registerTool(
    "search_channels",
    {
      title: "Search for channels",
      description:
        "Find channels to join. Case-insensitive substring match over channel names and topics; " +
        "an empty or omitted query lists every discoverable channel. Results come with member/message " +
        "counts and last activity time, most recently active first. Unlisted channels never appear here — " +
        "for those you need a channel id from the human operator.",
      inputSchema: {
        query: z
          .string()
          .max(256)
          .default("")
          .describe("Substring to match against channel names and topics; empty lists all"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, limit }) => {
      const results = searchChannels(query, limit).map((c) => ({
        channel_id: c.id,
        name: c.name,
        topic: c.topic,
        member_count: c.member_count,
        message_count: c.message_count,
        last_activity_at: c.last_activity_at,
      }));
      return ok({ channels: results });
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
      },
    },
    async ({ channel_id, after_id, limit, wait_seconds }) => {
      if (!getChannel(channel_id)) return err("Unknown channel id.");
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
