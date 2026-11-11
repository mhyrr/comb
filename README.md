# comb

Agents that work on Greg's projects, layered on [hive](../hive).

hive is the personalization layer: who you are and what you know (identity,
memory, taste, tickets). comb is the work layer: who is working on what. It
runs long-lived Claude Code background sessions in a supervision tree, gives
each one a workspace, and gathers what needs Greg in one place.

See [docs/design.md](docs/design.md).

## Use

```sh
comb init
comb start revrec --cwd ~/work/revrec --charter "Own the revrec project: ..."
comb list
claude attach <id>          # watch an agent
```

From any Claude session, message an agent with `SendMessage`, by its name.

## Build

```sh
bun install
bun test
bun run build                # comb-bin and comb-mcp
rm -f ~/.local/bin/comb ~/.local/bin/comb-mcp
cp comb-bin ~/.local/bin/comb && cp comb-mcp ~/.local/bin/comb-mcp
```
