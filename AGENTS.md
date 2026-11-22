# comb

comb is the work layer: Claude Code background agents, best with hive
(D24). Read `docs/design.md` first.

## Rules

- **Work with and without hive (D24).** `detectHive` decides; every
  hive-backed feature checks it. Greg's install has hive, and nothing may
  change for it. Tests pin `COMB_HIVE` (or pass a `HiveSetup`), so they never
  depend on whether the machine has hive.
- **Never write `~/.hive`.** comb reads hive only through `hive identity emit`,
  the project registry files, the `hive` MCP server, and hive's nightly
  outputs (`next.json`, `briefings/`, ticket front matter; design §9.3). Its
  one write is through hive's own path: queue precedents go to the MCP's
  `write_hive_memory` as candidates (D13). All comb state lives
  in `~/.comb` (`COMB_HOME` overrides it). `src/hive.ts` is the only module
  that touches hive.
- **Never change global Claude config.** comb-mcp reaches agents through
  per-agent `--mcp-config`; skills will arrive per session (design §5.3).
  The one exception is the status-line tee (D28): `statusLine.command` in
  `~/.claude/settings.json`, only on the user's yes (`comb init` asks;
  `--install-statusline`), backed up first, undone by `--undo-statusline`.
  Tests install it into a fake HOME, never the real one.
- **Subscription auth only.** Agent starts remove `ANTHROPIC_API_KEY`. If
  OAuth fails, the start fails visibly.
- **Opinions about how work is done live in files** (charters, skills,
  precedents), not in code.
- Tests use a fake `claude` runner and must never start a real session or
  read the real `~/.hive`.

## Layout

- `src/cli.ts`: the `comb` command, including `comb page`.
- `src/mcp-server.ts`: comb-mcp (`agent_list`, `agent_send`, `agent_start`,
  `queue_add`, `queue_withdraw`).
- `src/queue.ts`: the queue (`~/.comb/queue/`) and precedents, which it also
  queues in hive memory (D13; `comb precedents sync` backfills).
- `src/nightly.ts`: files hive's nightly picks (and asks, with `nightlyAsks`) into the queue
  (`comb nightly`, and hourly from the page server), after its sweep withdraws
  open cards whose work is done or taken (D30).
- `src/agents.ts`: workspaces, the start path, the core contract.
- `src/claude.ts`: the Claude Code adapter (`--bg`, `claude agents --json`).
- `src/hive.ts`: the hive interface, including the hive MCP client the page
  uses to read tickets and memory and to queue precedents (`writeMemory`).
- `src/transcript.ts`: reads Claude Code transcripts into feed events.
- `src/statusline.ts`: the status-line tee (D28): `comb statusline` saves
  Claude Code's `rate_limits` to `~/.comb/cache/rate-limits.json`, then runs
  the old status line; install and undo for `comb init`.
- `src/limits.ts`: the plan-limit bars (session and weekly), read from that
  cache, with a warning when settings.json no longer runs the tee.
- `src/timeline.ts`: Now's "What each agent did", the last 24 hours per
  agent, from the usage index's turns, the queue and `reports/` (design doc
  `docs/design/2026-11-17-now-dashboard.md` §4.2). `src/page/ui/timeline.ts` draws it.
- `src/tools.ts`: Now's "Tools the agents use" (design doc §4.3), counts from the
  usage index; `src/mcphealth.ts` reads MCP health from Claude Code's MCP logs, read
  only, the one module that knows that format. `src/page/ui/tools.ts` draws it.
- `src/usage.ts`: token counts from Claude Code, Codex and Gemini CLI's local
  files for the Now tab's usage panel, with a per-file cache in
  `~/.comb/cache/usage.json`. `src/pricing.ts` is its one price table
  (API-equivalent dollars, with the source date). `src/page/ui/usage.ts` draws it.
- `src/page/`: comb's page (design §9.1). `server.ts` is the local server,
  `state.ts` the tree snapshot, `feed.ts` the transcript tail, `ui/` the
  browser code (plain TypeScript, bundled into the binary by Bun).
- `src/paths.ts`: `~/.comb`.
- `src/config.ts`: `~/.comb/config.json` (`userName`, `hive`, `nightlyAsks`,
  `identityFile`, `defaultModel`, `foldAfterHours`) and `renderTemplate` for `templates/`. The
  human's internal id stays `greg` whatever the name.
- `src/models.ts`: the model aliases Greg picks from (D25). One list; no Node
  imports, because the page's browser code uses it too.
- `src/page/ui/patch.ts`: keyed updates that keep focus and the reader's
  place (D26).
- `src/page/ui/tree.ts`: the rail's tree order (maya, working, newest first).
- `templates/`: Maya's charter (rendered at `comb init`) and the default
  identity for agents without hive (bundled into the binary).
- `scripts/fixture/`: an invented comb world for the README screenshots
  (`build.ts`, `serve.ts [--no-hive]`, a fake `claude` and a fake hive MCP
  server).
  Regenerate `docs/img/` from it, never from a real `~/.comb`.

## Checks

Before you call work done, run `bun run typecheck` (`tsc --noEmit`, strict; it
covers `src/`, `src/page/ui`, the tests and `scripts/`, and `bun run build`
runs it first) and `bun test`. Bun's bundler does not type-check, so a broken
import in `src/page/ui` passes the tests and only shows in a browser. Fix the
type; do not add `any` or `@ts-ignore`.

## Build and install

`bun run build`, then rm and cp `comb-bin` to `~/.local/bin/comb` and
`comb-mcp` to `~/.local/bin/comb-mcp`. On macOS, never copy over an existing
binary in place (rm first). Then run `comb init`: it restarts the
`com.comb.page` launch agent (`kickstart -k`) so the page runs the new
binary, and rewrites and reloads the plist only when the plist changed (D29).
