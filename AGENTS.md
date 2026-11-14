# comb

comb is the work layer on top of hive. Read `docs/design.md` first.

## Rules

- **Never write `~/.hive`.** comb reads hive only through `hive identity emit`,
  the project registry files, the `hive` MCP server, and hive's nightly
  outputs (`next.json`, `briefings/`, ticket front matter; design §9.3). All comb state lives
  in `~/.comb` (`COMB_HOME` overrides it). `src/hive.ts` is the only module
  that touches hive.
- **Never change global Claude config.** comb-mcp reaches agents through
  per-agent `--mcp-config`; skills will arrive per session (design §5.3).
- **Subscription auth only.** Agent starts remove `ANTHROPIC_API_KEY`. If
  OAuth fails, the start fails visibly.
- **Opinions about how work is done live in files** (charters, skills,
  precedents), not in code.
- Tests use a fake `claude` runner and must never start a real session or
  read the real `~/.hive`.

## Layout

- `src/cli.ts`: the `comb` command, including `comb page`.
- `src/mcp-server.ts`: comb-mcp (`agent_list`, `agent_send`, `agent_start`,
  `queue_add`).
- `src/queue.ts`: the queue (`~/.comb/queue/`) and precedents.
- `src/nightly.ts`: files hive's nightly picks and asks into the queue
  (`comb nightly`, and hourly from the page server).
- `src/agents.ts`: workspaces, the start path, the core contract.
- `src/claude.ts`: the Claude Code adapter (`--bg`, `claude agents --json`).
- `src/hive.ts`: the hive interface, including the read-only hive MCP client
  the page uses for tickets and memory.
- `src/transcript.ts`: reads Claude Code transcripts into feed events.
- `src/page/`: comb's page (design §9.1). `server.ts` is the local server,
  `state.ts` the tree snapshot, `feed.ts` the transcript tail, `ui/` the
  browser code (plain TypeScript, bundled into the binary by Bun).
- `src/paths.ts`: `~/.comb`.
- `src/config.ts`: `~/.comb/config.json` (`userName`, the page's name for the
  human; default "You"). Display only: the internal id stays `greg`.
- `scripts/fixture/`: an invented comb world for the README screenshots
  (`build.ts`, `serve.ts`, a fake `claude` and a fake hive MCP server).
  Regenerate `docs/img/` from it, never from a real `~/.comb`.

## Build and install

`bun run build`, then rm and cp `comb-bin` to `~/.local/bin/comb` and
`comb-mcp` to `~/.local/bin/comb-mcp`. On macOS, never copy over an existing
binary in place (rm first). Then run `comb init`: it reloads the
`com.comb.page` launch agent so the page runs the new binary.
