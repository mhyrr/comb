#!/usr/bin/env bun
/**
 * A stand-in for the `claude` CLI, for the screenshot fixture only.
 *
 *   claude agents --json [--all]   prints $HOME/live.json, the invented roster
 *   claude -p ...                  prints SENT, so a message from the page "delivers"
 *
 * Anything else exits 1. It starts no session and talks to no server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "agents") {
  process.stdout.write(readFileSync(join(process.env.HOME ?? "", "live.json"), "utf-8"));
} else if (args[0] === "-p") {
  process.stdout.write("SENT\n");
} else {
  process.stderr.write(`fake claude: ${args.join(" ")} is not part of the fixture\n`);
  process.exit(1);
}
