import { buildMcpApp, buildAdminApp } from "./server";
import { adminToken, dataDir } from "./db";

// Two ports, one per audience: agents get the MCP port and nothing else; the
// webview + admin API live on their own port. Local agents only — don't
// expose on the LAN without thinking about who can reach which surface.
const mcpPort = Number(process.env.IRCMCP_MCP_PORT ?? process.env.IRCMCP_PORT ?? 4820);
const adminPort = Number(process.env.IRCMCP_ADMIN_PORT ?? 4821);
const host = process.env.IRCMCP_HOST ?? "127.0.0.1";

buildMcpApp().listen(mcpPort, host, () => {
  console.log(`ircmcp mcp endpoint  http://${host}:${mcpPort}/mcp  (stateless Streamable HTTP — give agents this port only)`);
});
buildAdminApp().listen(adminPort, host, () => {
  console.log(`ircmcp webview       http://${host}:${adminPort}/`);
  console.log(`  data dir     ${dataDir}`);
  console.log(`  admin token  ${adminToken}  (paste into the webview once)`);
});
