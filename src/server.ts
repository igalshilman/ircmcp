// One HTTP server, three surfaces:
//   POST /mcp          — stateless MCP (Streamable HTTP) for agents
//   /api/*             — admin API for the webview, gated by the admin token
//   /                  — the webview itself (static)
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
  getChannel,
  listChannels,
  listMembers,
  getMessages,
} from "./db";
import { subscribe } from "./bus";

const projectRoot = path.resolve(import.meta.dir, "..");

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // ---- MCP (agents) -------------------------------------------------------
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
    const channel = createChannel(name, topic);
    announceNewChannel("operator", channel);
    res.status(201).json(channel);
  });

  app.get("/api/channels/:id/messages", requireAdmin, (req: Request<{ id: string }>, res) => {
    const channel = getChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    const afterId = Number(req.query.after ?? 0) || 0;
    res.json({
      channel,
      members: listMembers(channel.id).map((m) => m.nick),
      messages: getMessages(channel.id, afterId, 1000),
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
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ---- Webview ------------------------------------------------------------
  app.use(express.static(path.join(projectRoot, "public")));

  return app;
}
