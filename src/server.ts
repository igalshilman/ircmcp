// Two HTTP servers in one process, one per audience:
//   MCP app (agents):     POST /mcp — stateless MCP (Streamable HTTP), nothing else
//   Admin app (operator): /api/* gated by the admin token, plus the static webview
//
// Separate ports keep the surfaces from bleeding into each other — the port
// handed to agents serves only MCP. On loopback this is hygiene, not a hard
// boundary (any local process can dial both ports); the admin token remains
// the actual gate on the admin API.
//
// Express (and the MCP SDK's node-style transport) run on Bun's node:http
// compatibility layer — no Bun.serve adapter needed.
import express, { type RequestHandler, type Request, type Response } from "express";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { announceNewChannel, buildMcpServer } from "./mcp";
import {
  adminToken,
  createChannel,
  deleteChannel,
  findChannelsByText,
  getChannel,
  getTags,
  joinChannel,
  listChannels,
  listMembers,
  getMessages,
  normalizeTags,
  postMessage,
  setTags,
} from "./db";
import {
  publish,
  publishChannelDeleted,
  subscribe,
  subscribeAll,
  subscribeAllDeleted,
  subscribeDeleted,
} from "./bus";

const projectRoot = path.resolve(import.meta.dir, "..");

export function buildMcpApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Stateless mode: new server + transport per request, no session id.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp request failed:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  // Stateless => no server-push stream to resume and no session to delete.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP: POST only)" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

export function buildAdminApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // ---- Admin API (webview) ------------------------------------------------
  // The token lives in data/admin.token and is printed at startup. Agents are
  // never given it, so only the operator can create/enumerate channels.
  // EventSource can't set headers, hence the ?token= fallback for SSE.
  const requireAdmin: RequestHandler = (req, res, next) => {
    const token = req.get("x-admin-token") ?? req.query.token;
    if (token !== adminToken) {
      res.status(401).json({ error: "bad admin token" });
      return;
    }
    next();
  };

  app.get("/api/channels", requireAdmin, (_req, res) => {
    res.json({ channels: listChannels() });
  });

  app.post("/api/channels", requireAdmin, (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    // tags arrive as an array, or comma-separated from the webview's text input
    const rawTags = Array.isArray(req.body?.tags)
      ? req.body.tags.filter((t: unknown): t is string => typeof t === "string")
      : typeof req.body?.tags === "string"
        ? req.body.tags.split(",")
        : [];
    const tags = normalizeTags(rawTags);
    const channel = createChannel(name, topic, tags);
    announceNewChannel("operator", channel, tags);
    res.status(201).json({ ...channel, tags });
  });

  // Free-text search for the operator — same FTS the agents use, grouped by
  // channel with snippets.
  app.get("/api/search", requireAdmin, (req, res) => {
    const text = typeof req.query.text === "string" ? req.query.text : "";
    let results;
    try {
      results = findChannelsByText(text, 15);
    } catch {
      res.status(400).json({ error: "bad search text" });
      return;
    }
    if (results === null) {
      res.status(400).json({ error: "text required" });
      return;
    }
    res.json({ channels: results });
  });

  app.get("/api/channels/:id/messages", requireAdmin, (req: Request<{ id: string }>, res) => {
    const channel = getChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    const afterId = Number(req.query.after ?? 0) || 0;
    res.json({
      channel: { ...channel, tags: getTags(channel.id) },
      members: listMembers(channel.id).map((m) => m.nick),
      messages: getMessages(channel.id, afterId, 1000),
    });
  });

  // Batch channel deletion — operator only, there is deliberately no MCP tool
  // for this. Purges the channel and all its content; the lobby is refused.
  app.post("/api/channels/delete", requireAdmin, (req, res) => {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "ids required" });
      return;
    }
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      if (deleteChannel(id)) {
        publishChannelDeleted(id); // kick blocked long-polls + SSE streams
        deleted.push(id);
      } else {
        skipped.push(id); // unknown, or the lobby
      }
    }
    res.json({ deleted, skipped });
  });

  // The operator retagging a channel from the webview — same semantics and
  // in-channel announcement as the agents' set_tags tool.
  app.put("/api/channels/:id/tags", requireAdmin, (req: Request<{ id: string }>, res) => {
    const channel = getChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    const rawTags = Array.isArray(req.body?.tags)
      ? req.body.tags.filter((t: unknown): t is string => typeof t === "string")
      : typeof req.body?.tags === "string"
        ? req.body.tags.split(",")
        : [];
    const tags = normalizeTags(rawTags);
    const rawNick = typeof req.body?.nick === "string" ? req.body.nick.trim() : "";
    const nick = rawNick || "operator";
    setTags(channel.id, tags);
    publish(
      postMessage(
        channel.id,
        nick,
        tags.length ? `${nick} set tags to: ${tags.join(", ")}` : `${nick} cleared the tags`,
        "system",
      ),
    );
    res.json({ tags });
  });

  // The operator speaking from the webview. Goes through the same
  // postMessage + publish path as agent messages, so long-polling agents and
  // other SSE tabs wake up for it like for any other message.
  app.post("/api/channels/:id/messages", requireAdmin, (req: Request<{ id: string }>, res) => {
    const channel = getChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message required" });
      return;
    }
    const rawNick = typeof req.body?.nick === "string" ? req.body.nick.trim() : "";
    const nick = rawNick || "operator";
    joinChannel(channel.id, nick); // sending implies membership, same as the MCP tool
    const msg = postMessage(channel.id, nick, message);
    publish(msg);
    res.status(201).json(msg);
  });

  // Firehose across all channels — the webview uses it for unread badges on
  // channels other than the one being viewed.
  app.get("/api/events", requireAdmin, (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsub = subscribeAll((msg) => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const unsubDel = subscribeAllDeleted((channelId) => {
      res.write(`data: ${JSON.stringify({ kind: "channel_deleted", channel_id: channelId })}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
      unsubDel();
    });
  });

  app.get("/api/channels/:id/events", requireAdmin, (req: Request<{ id: string }>, res) => {
    const channel = getChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsub = subscribe(channel.id, (msg) => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const unsubDel = subscribeDeleted(channel.id, () => {
      // typed SSE event so the webview can distinguish "deleted" from data
      res.write(`event: deleted\ndata: {"channel_id":"${channel.id}"}\n\n`);
      res.end();
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
      unsubDel();
    });
  });

  // ---- Webview ------------------------------------------------------------
  app.use(express.static(path.join(projectRoot, "public")));

  return app;
}
