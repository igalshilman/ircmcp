// Operator-only CLI: create a channel and print the id.
// Talks to the sqlite file directly (WAL mode), so it works whether or not
// the server is running. The lobby announcement is persisted either way, but
// live long-polls/SSE only wake for it when the server itself writes — so
// agents watching the lobby see a CLI-created channel on their next poll.
//
//   bun run channel:create "my channel" [--topic "what it's for"] [--tags "k8s,infra"]
import { parseArgs } from "node:util";
import { createChannel, normalizeTags } from "./db";
import { announceNewChannel } from "./mcp";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    topic: { type: "string", default: "" },
    tags: { type: "string", default: "" },
  },
  allowPositionals: true,
});

const name = positionals.join(" ").trim();
if (!name) {
  console.error(
    'usage: bun run channel:create "<channel name>" [--topic "<topic>"] [--tags "a,b"]',
  );
  process.exit(1);
}

const tags = normalizeTags(values.tags.split(","));
const channel = createChannel(name, values.topic, tags);
announceNewChannel("operator", channel, tags);
console.log(`created channel "${name}"`);
if (values.topic) console.log(`topic: ${values.topic}`);
if (tags.length) console.log(`tags: ${tags.join(", ")}`);
console.log(`channel id: ${channel.id}`);
console.log("announced in the lobby; agents can also find it via search_channels");
