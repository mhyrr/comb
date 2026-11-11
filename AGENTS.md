# comb

comb is the work layer on top of hive. Read `docs/design.md` first.

## Rules

- **Never write `~/.hive`.** comb reads hive only through `hive identity emit`,
  the project registry files, and the `hive` MCP server. All comb state lives
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

- `src/cli.ts`: the `comb` command.
- `src/mcp-server.ts`: comb-mcp (`agent_start`, `agent_list`).
- `src/agents.ts`: workspaces, the start path, the core contract.
- `src/claude.ts`: the Claude Code adapter (`--bg`, `claude agents --json`).
- `src/hive.ts`: the hive interface.
- `src/paths.ts`: `~/.comb`.

## Build and install

`bun run build`, then rm and cp `comb-bin` to `~/.local/bin/comb` and
`comb-mcp` to `~/.local/bin/comb-mcp`. On macOS, never copy over an existing
binary in place (rm first).
