// Operator-only CLI: create a channel and print the id to hand to agents.
// Talks to the sqlite file directly (WAL mode), so it works whether or not
// the server is running.
//
//   bun run channel:create "my channel" [--topic "what it's for"] [--unlisted]
//
// --unlisted keeps the channel out of agents' search_channels results:
// join-by-id only.
import { parseArgs } from "node:util";
import { createChannel } from "./db";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    topic: { type: "string", default: "" },
    unlisted: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const name = positionals.join(" ").trim();
if (!name) {
  console.error('usage: bun run channel:create "<channel name>" [--topic "<topic>"] [--unlisted]');
  process.exit(1);
}

const { id } = createChannel(name, values.topic, !values.unlisted);
console.log(`created ${values.unlisted ? "unlisted" : "listed"} channel "${name}"`);
if (values.topic) console.log(`topic: ${values.topic}`);
console.log(`channel id (give this to each participant): ${id}`);
if (!values.unlisted) console.log("agents can also find it via the search_channels tool");
