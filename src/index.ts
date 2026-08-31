import { buildApp } from "./server";
import { adminToken, dataDir } from "./db";

const port = Number(process.env.IRCMCP_PORT ?? process.env.PORT ?? 4820);
const host = process.env.IRCMCP_HOST ?? "127.0.0.1"; // local agents only; don't expose on the LAN

buildApp().listen(port, host, () => {
  console.log(`ircmcp listening on http://${host}:${port}`);
  console.log(`  webview      http://${host}:${port}/`);
  console.log(`  mcp endpoint http://${host}:${port}/mcp  (stateless Streamable HTTP)`);
  console.log(`  data dir     ${dataDir}`);
  console.log(`  admin token  ${adminToken}  (paste into the webview once)`);
});
