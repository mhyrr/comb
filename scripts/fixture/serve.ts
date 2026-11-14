#!/usr/bin/env bun
/**
 * Serves comb's page against a fixture from build.ts, with the fake `claude`
 * and the fake hive MCP server. Nothing reads the real ~/.comb, ~/.claude or
 * ~/.hive: HOME points into the fixture.
 *
 *   bun scripts/fixture/serve.ts <dir> [port]     (port defaults to 4799)
 */
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: bun scripts/fixture/serve.ts <dir> [port]");
  process.exit(2);
}
const port = process.argv[3] ?? "4799";
const here = import.meta.dir;
const repo = resolve(here, "..", "..");
const home = join(dir, "home");
const fakeClaude = join(here, "fake-claude.ts");
chmodSync(fakeClaude, 0o755);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
delete env.ANTHROPIC_API_KEY;
Object.assign(env, {
  HOME: home,
  COMB_HOME: join(home, ".comb"),
  HIVE_HOME: join(home, ".hive"),
  COMB_CLAUDE_BIN: fakeClaude,
  COMB_HIVE_MCP: `${process.execPath} ${join(here, "fake-hive-mcp.ts")}`,
  COMB_REX_BIN: "/nonexistent",
});

console.log(`comb page (fixture) at http://127.0.0.1:${port}`);
const child = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "page", "--serve", "--port", port], { env, stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
await child.exited;
