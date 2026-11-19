# comb — Design

**Status:** living design. Step 1 is built.
**Started:** 2026-11-07 as "HIVE v2" (branch `hive-v2` in the hive repo).
Became comb on 2026-11-11.

## 1. What comb is

Greg is the bottleneck. Today every idea needs him through the whole loop:
think, research, design, implement, test, review. comb exists so he can hand
that loop off, get the idea across, and then manage, nudge and guide
direction instead of writing a design doc and iterating every time.

comb is a small supervision tree of Claude Code agents, one job each, with what
needs Greg gathered in one place.

**comb is a layer on top of hive, not a new version of it.**

| | hive | comb |
|---|---|---|
| Is | The personalization layer | The work layer |
| Answers | Who you are, what you know | Who is working on what |
| Owns | Identity, memory, taste, tickets, council, nightly pipeline | Agents, the tree, skills for agent roles, the queue, precedents |
| State | `~/.hive` | `~/.comb` |

comb runs on plain Claude Code and is best with hive (D24). When hive is
installed, comb reads it through stable interfaces and never writes
`~/.hive`:

- **Identity:** `hive identity emit`, run in the agent's directory, so it
  carries that project's memory index and stack hint.
- **Projects:** the registry files `~/.hive/projects/<name>/config.md`.
- **Memory and tickets:** the `hive` MCP server, which every Claude session
  already loads. Agents read and write project memory and tickets there.

Nothing in comb merges back into hive. There is no cutover.

Without hive, agents get comb's own identity (`~/.comb/identity.md`), take
their work from charters and the queue, and the page's Tickets and Memory
tabs say to install hive. comb has no ticket system of its own.

### How Greg works with it

Three places, each with one job (agreed 2026-11-11):

| Place | Job | What Greg does there |
|---|---|---|
| **His `hive` session** | Doing | Hands-on work with Greg in the loop, as today |
| **Maya** | Delegating | The one address for "take this, come back with something reviewable" |
| **comb's page** | Overseeing | What is running, what is waiting on him, what finished |

- comb has no conversation of its own. Greg always talks to an agent; comb
  is the window onto all of them.
- **Greg never runs `comb` himself.** comb is a tool his sessions and agents
  use: `comb-mcp` is registered for his Claude sessions at user scope, so any
  session can start, list and manage agents. The `comb` command stays for
  building and debugging.
- **Greg addresses agents by name** in his own session: "maya, what's
  waiting on me in acme-api?" His session relays that to Maya with
  `SendMessage` and brings her answer back.
- **His session offers hand-offs.** When work can run without Greg and come
  back reviewable, his session offers to hand it to Maya, and packs the
  context (what Greg said, decisions so far, the repo) when he says yes. It
  never hands off on its own. Trust is earned later, deliberately.
- **Maya sees Greg's own sessions.** `claude agents --json` lists interactive
  sessions too, so she can avoid starting work where Greg is already working.

Both behaviors in Greg's session come from one skill, `comb-handoff`,
installed by `comb init` into `~/.claude/skills/`. That skill and the
user-scope `comb-mcp` entry are comb's two deliberate additions to Greg's
global Claude setup. Agents also get `comb-mcp` through their own
`--mcp-config`, which takes precedence (verified), so `COMB_AGENT` still
makes the agent the parent of what it starts.

## 2. Principles

1. **Trust the model and the harness.** When something is uncertain, the
   answer is the supervision tree, not a rule.
2. **Claude Code does the work; comb keeps track.** Sessions, sub-agents,
   worktrees, browsers, hooks, skills and messaging belong to Claude Code.
   comb calls them; it does not copy them.
3. **Every agent thinks.** Plumbing only stores and routes.
4. **Taste travels as files.** Charters, skills and precedents are files Greg
   can read and edit. Code holds no opinions about how work is done.
5. **Ideas branch.** A good idea never stops work; it becomes a sibling agent
   on its own branch.

## 3. The tree

One concept: an **agent**, a Claude Code background session with one job,
its own workspace, a charter, skills and a parent. The tree is who started
whom.

```
Greg
 ├─ Maya, chief of staff              (charter: look across everything)
 │   ├─ acme-api-tk109-backtest         (charter: build TK-109 step 1, own worktree)
 │   │   └─ acme-api-tk109-review       (charter: review the backtest branch)
 │   ├─ docs-site-show-hn          (charter: draft the Show HN post)
 │   └─ release-notes                 (charter: this week's notes)
 └─ Greg's own sessions               (outside the tree; on the page, not Maya's)
```

- **Maya** is the chief of staff at the top. She thinks across everything:
  conflicts, duplicated work, shared blockers, priorities.
- **Task agents** sit under Maya, one per job (D21): a ticket, an approved
  proposal, a review. Each starts fresh, in the project's repo on its own
  worktree, with a charter that carries its context: what done means, the
  ticket, Maya's context, and where the design docs and hive memory are.
- **A job keeps its agent.** Follow-ups, review fixes and Greg's redirects go
  to the agent already doing that job, because its context is that job. A
  new job gets a new agent. Greg reads and messages any of them on his page.
- **Any agent can start children** for a separate job, and uses its own
  sub-agents for parallel reading inside its job. That gives three levels:
  Maya, task agents, and their children.
- **An agent finishes** with a report and stops working. Its workspace and
  session stay, so a message wakes it with its history.
- **Greg's own sessions are outside the tree** (D9). The page shows them and
  he can message them there. An agent may answer one that wrote to it, and
  comb refuses an agent's message to one that did not.
- **Claude sub-agents** live inside an agent's session and are invisible to
  comb. The agent that used them answers for them.
- Agents are real background sessions (visible in `claude agents`), never
  `claude -p`.

## 4. Workspaces

```
~/.comb/
  agents/<name>/
    charter.md          what this agent is for (Greg-editable)
    checklist.md        what to look at each time it wakes (Greg-editable)
    log.md              one line per action: `- <ISO time> what, and why`
    reports/            one file per finished piece of work
    memory/             its own notes
    session.json        session ID, parent, project, cwd, how to resume
    system-prompt.md    exactly what the session was told (generated)
    mcp.json            its comb-mcp config (generated)
  queue/<item-id>/      item.md and evidence/ (step 6)
  precedents/           Greg's answers, one file each (step 6)
```

- Each agent writes only its own folder and the repo it works in.
- The charter is the scope. There is no permission format.
- The workspace is what lasts (D3). A session can be cleared or die; a new
  one resumes or restarts from the workspace.

## 5. Skills: what makes a role

Agents are all the same kind of thing. Three files make one different from
another:

- **The charter**: what it is for.
- **Its skills**: how it works.
- **Precedents**: how Greg decided before.

Skills are Claude Code `SKILL.md` playbooks. They explain how to do something
well; they gate nothing. They are where Greg's taste about *process* lives, the
way hive's taste files hold his taste about *output*.

### 5.1 The work loop comes first

The skill that matters most is the one Greg wants to hand off: **take an idea
from Greg to a reviewable result.** It sequences skills Greg already has
rather than reinventing them:

| Stage | Existing skill |
|---|---|
| Understand the ask | (the loop skill itself: restate it, find the real problem) |
| Research | `researcher`, web search, hive memory |
| Design | `grill-me` and `planreview`, aimed at the agent's own plan |
| Build | test-driven development |
| Verify | `run`, browser checks |
| Review | `code-review`, `simplify`, `deslopify` for prose |
| Hand back | a report, and a queue item when Greg must look |

The loop skill also says **where the agent stops for Greg** and where it keeps
going. That is where the tension between control and letting go is settled,
in one file Greg can edit. (Open question Q1.)

### 5.2 Layers

| Layer | Carried by | Holds |
|---|---|---|
| **Core** | Every agent | The workspace contract, talking in the tree, when to decide vs. escalate, using hive memory and tickets |
| **Work loop** | Agents that build | §5.1 |
| **Maya** | The chief of staff | Reading the whole tree, ranking the queue, spotting collisions, supervising quiet children |
| **Task** | Task agents | Ticket workflow, starting reviewer children, proposals as small bets. Stack skills come from the repo (`hive stack`) |
| **Task** | Children | Whatever the parent picks when it calls `agent_start` |

- **Keep the core lean.** Every skill's description sits in context; long
  material goes in supporting files the skill points to.
- **Skills are where learning lands.** When precedents keep teaching the same
  lesson, an agent proposes a skill edit through the queue. Greg edits any
  skill directly.

### 5.3 Delivery (to verify)

Delivery must be scoped to comb's sessions. Writing agent definitions to
`~/.claude/agents/` is ruled out: that folder is global, so every Claude
session Greg opens would list them.

The plan: comb keeps the skill library in this repo as a Claude Code plugin
and passes it to each agent with `--plugin-dir`, choosing layers per agent.
The core contract stays in the appended system prompt, so it is always
present (today it is `agentPreamble` in `src/agents.ts`; it moves to a file).
`--agents <json>` with `--agent` is the fallback if a role needs a whole agent
definition. To verify with `--bg`: plugin skills load, the skill descriptions
appear, and nothing leaks into Greg's other sessions.

## 6. How agents run and talk

**Start.** `comb start` or the `agent_start` tool:

1. checks the name is free among live sessions;
2. gets identity from `hive identity emit` in the agent's directory;
3. creates the workspace and writes `system-prompt.md` (identity plus the
   core contract) and `mcp.json` (comb-mcp, with `COMB_AGENT` set so the
   server knows whose children it starts);
4. runs `claude --bg --mcp-config … -n <name> --permission-mode auto
   --append-system-prompt-file … [-w <name>] "<prompt>"` with
   `ANTHROPIC_API_KEY` removed and `HIVE_IDENTITY_IN_PROMPT=1`;
5. records `session.json` and a log line.

Starting an existing agent without a charter resumes its last session, so
its history survives. With `fresh` (`agent_start`) or `--fresh` (`comb
start`), it starts a new conversation from the workspace instead, stopping
the old session first if it is live (D27).

**Talk.** Messages ride the harness (D6): agents use Claude Code's
`SendMessage` by name. A child tells its parent it finished, is stuck, has a
question or an idea. Greg reaches Maya the same way from any Claude session.

**Wake.** An agent wakes when it gets a message, or (later) when a timer
nudges it to walk its checklist.

## 7. Supervision

When a child reports, its parent thinks and does what makes sense: continue,
redirect, answer, verify with another agent, explore, stop, or escalate. No
rules engine.

- **When unsure, go up**, adding your own read on the way, so Greg sees a
  stack of recommendations rather than a raw question.
- **Silent death is not allowed** (D7). A session that leaves the live list
  without writing a report died, and its parent must learn that.
- **Precedents** move decisions down the tree over time.

## 8. Safety

- hive's `TRUST.md`: internal actions freely; external actions (push, deploy,
  send, post, spend) go to Greg; hard limits never.
- Code changes happen on the agent's own worktree and branch. Agents never
  merge or push.
- Inside that, Claude Code's own safety (auto mode, sandbox, permissions).

## 9. The queue and what Greg sees

Items under `~/.comb/queue/`: review, decision, proposal, blocker. Each has
the agent that raised it, each level's recommendation, evidence, and
one-key approve / reject / redirect with an optional reason. Maya ranks it.
Greg's answer goes back to the agent and, with his reason, into
`precedents/`.

comb's page is comb's main surface, its own local server; hive's dashboard
stays hive's. From the top: **Waiting on you** (the queue), **Now** (one line
per agent in tree order, plus Greg's own open sessions), **Reports**
(finished work, newest first).

**The page can wake any agent.** There is no `claude send` command, and
`SendMessage`'s local transport is internal (per-session keys), so comb does
not imitate it. Instead the comb server starts a one-shot
`claude -p --model haiku --allowedTools SendMessage` that sends Greg's text
to the agent by name. Verified 2026-11-11: delivered in about 5 seconds.
The relay carries text only; it decides nothing. Replace it if Claude Code
ships a native send.

So the page can answer from the start: approve / reject / redirect with a
reason on a queue item, and a short message to any agent.

### 9.1 The page, first cut (built 2026-11-11)

It is always up at `http://127.0.0.1:4747`: `comb init` installs a launchd
agent, `com.comb.page`, that runs `comb page --serve` (through `/bin/sh`,
D29) at login and restarts it if it exits (log: `~/.comb/logs/page.log`). Greg never starts it (D16);
`comb page` just opens it. It answers what hive's dashboard
does not: it is one screen, live, and interactive. Greg rejected the hive
dashboard as too busy, too long, and read-only.

**Layout.** One viewport with no page scroll. Three panes:

| Pane | Shows |
|---|---|
| Left | The tree (Greg → Maya → children), then Greg's own open sessions, then other sessions |
| Center | The selected agent or session: Activity, and for agents Charter, Log and Reports. Tickets and Memory take over the center from the top bar |
| Right | Maya, always open: the conversation, and a box to message her |

⌘K jumps to any agent, session, project's tickets or memory.

**Where each thing comes from.**

- The tree and its state: `~/.comb/agents/*/session.json` joined with
  `claude agents --json`, polled every 2.5 seconds while a page is open.
  `working` is a live session on a turn. `waiting` is live and idle. `asleep`
  is ended or retired; a message still wakes it (D17).
- Live work: the session transcript,
  `~/.claude/projects/<cwd with / and . as ->/<sessionId>.jsonl`, tailed and
  parsed into four events: a message in, the agent's text, a tool call (and
  its result), and the end of a turn. Sub-agent (sidechain) lines are
  skipped: the agent answers for them.
- Maya's conversation is her transcript. The page sends with
  `sendToAgent`, signed "Greg, on the comb page", and asks for no
  `agent_send` reply. Her answer is her next turn, which the page shows. No
  reply routing exists.
- Tickets and memory: the page server is an MCP client of the `hive` server,
  launched with the command in Greg's user-scope Claude config. Read-only.
- Usage (the Now tab's side column, `src/usage.ts`, added 2026-11-17): token
  counts from every harness that keeps them locally. Claude Code's
  `~/.claude/projects/**/*.jsonl` assistant `message.usage`, deduped by
  message id, because each content block repeats the usage line and resumed
  sessions copy earlier messages into a new file (on 2026-11-17, summing
  every line counted today's output 2.8 times over). Codex's
  `~/.codex/sessions` `token_count` events, whose totals are cumulative, so
  each record is the step since the last one. Gemini CLI's
  `~/.gemini/tmp/*/chats/*.json` per-message tokens. Cursor keeps no token
  counts locally, and the panel says so. ChatGPT on the web keeps no local
  record and is not shown; nothing calls an account API. Transcripts are
  append-only, so each file is read on from where the last read stopped, and
  the per-file results persist in `~/.comb/cache/usage.json` keyed by path,
  mtime and size: the first read of 4.3 GB took 8 seconds, a restart 80 ms.
  The server reads off the request path, at most once a minute, and only
  once someone opens the page. Dollars come from one table,
  `src/pricing.ts`, with its source date, and are labeled API-equivalent.
  Models without a price we trust (Haiku 5.5, fast mode, every non-Claude
  model) are left out of the dollars, and the panel says how much was left out.
  The same read also keeps, for 8 days, each finished turn (Claude Code's
  `turn_duration` line: end and length) and each tool call (id, time,
  session and name only; for Bash, the first word of the command when it is
  `gh`, and nothing else of it), for the Now timeline and tools panel
  (2026-11-19, cache version 2; design doc
  `docs/design/2026-11-17-now-dashboard.md` §4.2–4.3). Both are deduped by
  the id a resumed session's copy keeps (the turn's uuid, the `toolu_` id).
  Sub-agent turns are skipped; their tool calls count for the agent. The
  version bump costs one full re-read after upgrading: 12.7 s on 2026-11-19's
  transcripts, against 11.2 s for version 1 on the same files.
- Plan limits (top of the usage panel, `src/limits.ts`, added 2026-11-17,
  Greg: "I care most about my limits"). These are the session (5-hour) and
  weekly bars from Claude Code's `/usage`. Claude Code hands them to the
  statusLine command as `rate_limits.five_hour` and `rate_limits.seven_day`
  (`used_percentage`, `resets_at`); this is the only documented,
  credential-free source. comb gets it through its own status-line tee
  (D28): `comb statusline` saves the object to
  `~/.comb/cache/rate-limits.json` with the time it saw it, and `src/limits.ts`
  reads that file. comb touches no credentials and calls no endpoint. The
  file changes only when a session renders its status line, so the panel
  shows "as of" that time, marks it stale after 30 minutes, and drops a
  window's percentage once its `resets_at` has passed. With no reading it
  says how to install the tee; when settings.json no longer runs the tee it
  keeps the last bars and warns that they stop updating. The per-model weekly
  bar (Fable) is not in `rate_limits`, so the panel says it is only in
  `/usage`. The first cut read Vibe Island's copy of the same object; Greg
  removed that ("I don't want vibe island to be a dependency in this").
- Layout of Now's grid. Tickets, usage and reports are grid items placed by
  area. With the stage at least 1440px wide (a 2120px window with Maya open,
  1730px without), Now has three columns: queue | tickets, then reports |
  usage, with usage at the top of its own column. Below that it falls back to
  two columns, with usage between tickets and reports, and at 980px and under
  to one column.

**Finished.** Finished agents fold out of the tree into a collapsed
**Finished** group under it (D22). A task agent folds when it has at least
one file in `reports/`, is not on a turn, and has done nothing for one day
(`foldAfterHours` in `~/.comb/config.json`, default 24; `FOLD_AFTER_MS` in
`src/page/state.ts`). Its last activity is its
transcript's last event, or `log.md`'s mtime once Claude Code has pruned the
transcript. Maya never folds. A parent stays while any child of its stays.
Greg's own sessions fold only once their process has ended, then by last
activity with the same window, into a Finished group under Your sessions.
An open session never folds (2026-11-17): a terminal tab he keeps for
weeks is a workspace, not finished work, and folding hid seven of his
twelve open tabs. Your sessions shows the six most recent, working first,
and a "N more, quiet" row opens the rest. The group opens with one click, and opens by
itself when the selected row is in it. Folding deletes nothing: a message
still wakes the agent, and a woken agent is back in the tree.

**Tree order.** Maya comes first. Under each parent, a working agent comes
first, then the rest by last activity, newest first, then by name
(`treeOrder` in `src/page/ui/tree.ts`). Live work sits at the top of its
branch, and the rows that are about to fold sit at the bottom.

**Open in terminal** (built 2026-11-12; `hive attach` 2026-11-13). Each
agent's header has the `hive attach <name>` command (click copies it) and an
Open in terminal button. `hive attach` reads the agent's `session.json`,
attaches by the live session's short id (`claude attach` matches partial
names, and the roster can hold several ended rows with the same name), and
on an ended session prints how to wake the agent instead of resuming it.
Greg's own background sessions are not comb agents, so their chip keeps
`claude attach <name>`. The button copies the command and asks the server to open a tab in
the agent's directory running it: a tab in a Rex session labelled `comb`
(made on first use, then shown in the Rex app), or a Terminal.app window if
Rex is missing or fails. `src/terminal.ts` does the work. The server finds
`hive` on PATH, then at `~/.local/bin/hive` (launchd's PATH rarely holds
it). If hive is missing, the tab runs `claude attach <name>` and the
response says so. The server accepts only a name with a `session.json`, and
runs nothing but that command, built as an argv; Terminal.app gets the
directory and the command's words as AppleScript arguments under `quoted
form of`. Greg's own sessions get no
button. Taking an agent over (stop, then `--resume`) stays manual.

The directory is session.json's `cwd`, which for a worktree agent is already
`<repo>/.claude/worktrees/<name>`. One record has been seen with that path
doubled, so for a worktree agent the server cuts `cwd` after the first
`.claude/worktrees/<name>`, or appends it to a repo-root `cwd`, and uses the
first path that exists.

**Safety.** The server binds to loopback, and refuses requests whose `Host`
or `Origin` is not its own, so another site cannot post messages to agents.

**Look.** Light first, dark follows the OS. Porcelain ground, indigo ink,
one honey accent that only ever means "working". Schibsted Grotesk; Fragment
Mono only for code (tool calls, paths, commands). Each agent is a hex cell
that fills with honey while it works; that is the page's one ambient motion.

### 9.2 The queue, first cut (built 2026-11-11)

- **Agents file; the page never parses prose.** `queue_add` (comb-mcp) takes
  a kind (proposal, decision, review, blocker), a title, what the agent does
  on "go", and its case in Markdown. Each item is
  `~/.comb/queue/<date>-<slug>/item.md`: `key: value` lines between `---`
  fences, then the case. The core contract tells every agent to file asks
  this way instead of burying them in a reply.
- **Greg answers with Go, Not now (optional reason) or Redirect (required
  instruction).** The page delivers the answer to the asking agent first and
  marks the item only after delivery, so an undelivered answer stays open.
  Each answer writes `precedents/<item-id>.md` with his reason, and with
  hive also queues it in hive memory (D13).
- **Start on a ticket** sends Maya one signed message: start a task agent
  for it (D21) with the ticket, her context and where the docs and memory
  are, and do not come back to Greg first. Maya routes; the page does not.
- **Now is the dashboard:** the headline sentence, then the figure strip
  (2026-11-19, `src/page/ui/strip.ts`; design doc
  `docs/design/2026-11-17-now-dashboard.md` §4.1): Working now, Waiting on
  you (with the oldest item's age), Ready to merge (from the PR report;
  left out without hive) and Session limit (from `limits.ts`). Each figure
  has one line of context, and a source that is loading, missing or stale
  shows "…" or "—" in grey with the reason. Then Waiting on you, Latest from
  your sessions (each one's last words), Priority tickets (open P0 and P1,
  each with Start), Finished work (reports with their first paragraph). The
  strip replaced the headline's subline and the Working now section.
- **What each agent did (2026-11-19, `src/timeline.ts`, `src/page/ui/timeline.ts`;
  design doc §4.2).** The last 24 hours, one lane per agent that did anything
  in them, beside the queue (across the two right columns on wide screens).
  Bars are turns, from Claude Code's `turn_duration` lines through the usage
  index, merged when under 2 minutes apart; a striped bar is the turn running
  now (calls after the current session's last turn end). Rings are queue items
  the agent filed, filled once answered; a green hex is a report (its mtime); a
  red hex a blocker. The right side says each agent's state in words: Working
  (turn length), Waiting on you or Blocked (age), Finished, Idle, Asleep.
  Agents own sessions through `session.json` and the `(session xxxxxxxx)` ids
  on log.md's started-by and resumed-by lines, because a woken agent gets a
  new session. One grey lane is the user's own sessions: turns whose session
  is no agent's, not a `claude -p` run (entrypoint `sdk-cli`), and not a
  background session in `claude agents --json --all` (read at most once a
  minute). Transcripts can't tell interactive from background on their own:
  every session says `entrypoint: "cli"`, `userType: "external"` (checked
  2026-11-19). The latest gap of an hour or more in that lane is shaded as
  "away", and a sentence on top says who finished, who waits, who still works.
  Without the background list the user's lane is left out, and the page says so.
- **Go carries a model when it starts work (D25, 2026-11-15).** A proposal,
  or a review whose filer named a model, shows "Go · Opus ▾". The caret
  lists the models in `src/models.ts` (opus, sonnet, fable); the filer's
  pick is checked, with its one-line reason. The default is the item's
  `model` (queue_add's optional `model` and `model_why`), else
  `defaultModel` in `~/.comb/config.json`, else opus. Greg's pick goes back
  in the answer, `Go (model: fable): <action>`, with a line telling the
  agent to pass it to agent_start, and is saved in the item and the
  precedent. Decisions and blockers get a plain Go and refuse a `model`.
- **Updates never move what Greg is using (D26, 2026-11-15).** Cards are
  patched by queue id (`src/page/ui/patch.ts`), not rebuilt; a focused field
  is carried into new markup as the same node; time text is not a change;
  the card in view keeps its screen position when rows above it change.
  While Greg is busy with the queue (focus in it, a note form, case or model
  menu open, or scrolled past its top), new items wait behind an "N new,
  show" pill, and come in on click or at the next quiet moment.
- Not built yet: Maya ranking the queue, and `precedents_search`.

### 9.3 hive's nightly in the queue (built 2026-11-13)

hive writes two things each night that wait on Greg: the Act watches' picks
in `~/.hive/next.json` (one ticket per project, with a rationale) and the
briefing's "What needs your attention" list. Before this they sat in a file
and a briefing. Now comb files them as queue items from Maya (D23).

- **What comb reads, read-only:** `next.json` (`selections` with
  `disposition: recommended`), today's `~/.hive/briefings/<date>.md`, and
  each picked ticket's front matter in
  `~/.hive/projects/<p>/tickets/<id>.md`. The readers are in `src/hive.ts`.
  hive does not know comb reads them.
- **A pick becomes a proposal.** Title `Start <project> <ticket>: <ticket
  title>`; action `Maya starts task agent <project>-<ticket> on <project>
  <ticket>.`; the case is hive's rationale. On Go, the answer reaches Maya,
  who starts the task agent (D21).
- **Asks are off by default (2026-11-15).** Only with `nightlyAsks: true`
  in `~/.comb/config.json` does comb read the briefing at all; without it,
  `comb nightly --dry-run` prints `asks: off (set nightlyAsks in
  config.json)` in place of the asks. See D23.
- **An attention item becomes a decision** (when asks are on). The title is the item's text;
  the action is that Maya acts on Greg's answer. Go means carry it out as
  written; Redirect carries his answer. The project comes from the bold lead
  (`**acme-api:**`), the ticket from the first `TK-n` in the text.
- **Skips, each reported with its reason:** a pick older than 7 days; a pick
  whose ticket is closed or done, or that hive has no file for; anything
  with an open queue item on the same project and ticket (ticket field, or
  the id in the title) or the same title; an ask about a ticket that a
  current pick already covers.
- **Never twice.** `~/.comb/nightly/filed.json` records every filed item, by
  project+ticket+`selectedAt` for a pick and date+text for an ask, so an
  answered item is not refiled. hive re-picks a ticket with a new
  `selectedAt` (twice on 2026-11-13 alone), and briefings repeat asks, so the
  same project+ticket, or the same ask text, is also skipped for 7 days
  after it was filed; after that, a ticket hive still picks is asked again.
  Records older than 30 days are pruned.
- **Caps.** At most one pick per project a night, and 10 items a night
  (local date). Asks are filed first because they do not come back: an
  excess ask is dropped (tomorrow's briefing carries what still matters),
  while an excess pick is filed the next night if hive still picks it and
  it is under 7 days old.
- **When it runs.** The page server runs it at start and every hour; its log
  is `~/.comb/logs/page.log`. `comb nightly` runs it by hand, and
  `comb nightly --dry-run` prints what it would file and why it skips the
  rest, writing nothing.

## 10. Decisions

- **D1. Maya is a background Claude Code session on the subscription.**
  Greg opens her with `comb maya` or messages her with `SendMessage`.
- **D2. Claude Code only, for now** (2026-11-11). Other harnesses read the
  same `SKILL.md` format and can come later; a message bridge is needed only
  across harnesses.
- **D3. Recovery is from the workspace.** Agents keep what matters in
  `log.md` and `memory/`, not in context.
- **D4. Watches and campaigns are deleted** from hive (hive PR #41).
- **D5. (Replaced by D21.)** Project agents came from an explicit list of six.
- **D6. Messages ride the harness** (2026-11-10). No comb `message` tool.
  All comb agents run in one permission mode (`auto`, override with
  `COMB_PERMISSION_MODE`), because Claude holds messages between sessions in
  different modes for approval.
- **D7. Supervision works like an Erlang supervision tree.** A parent learns
  when a child exits or hangs. Silent death is a signal, not silence.
- **D8. Incoming messages ride the harness.** Busy-session behavior is
  Claude Code's.
- **D9. No driving mode.** Greg's sessions stay outside the tree and talk to
  Maya. He can still `claude attach` to watch any agent. (2026-11-12) They
  show on the page and Greg can message them there; they are still not
  Maya's to hand work to, and comb enforces that (§3).
- **D10. comb is its own tool on top of hive** (2026-11-11). Separate repo,
  binary, state (`~/.comb`) and MCP server (`comb-mcp`). It reads hive and
  never writes `~/.hive`. Supersedes "hv runs beside hive until cutover."
- **D11. Subscription-only auth.** Every agent start removes
  `ANTHROPIC_API_KEY`; if OAuth fails, the start fails visibly.
- **D12. Skills define roles** (2026-11-11), delivered per session (§5.3).
  The work-loop skill comes first.
- **D13. Precedents live in comb, and with hive they also go to hive memory**
  (2026-11-12, built 2026-11-18, TK-001). The file `precedents/<id>.md` is
  comb's record. hive's `search_memory` could not see it, so agents re-asked
  what Greg had answered. Now `recordAnswer` also calls hive's own write
  path, `write_hive_memory` on the hive MCP (client in `src/hive.ts`; comb
  still never writes `~/.hive`). Each entry is a `decision` tagged
  `precedent` and `queue`, scoped to the item's project (comb when hive does
  not register it), in one sentence a later agent can act on: `Greg declined
  maya's proposal "…" (instadash TK-009) on 2026-11-18: not now. Proposed: …
  Reason: …`. It is sent as a directive: the answer is Greg's own call, and
  a page click leaves no session transcript for the nightly verifier to
  cite, so a plain candidate would likely be rejected. The verifier still
  words and places it. The outcome is recorded in comb: a `- Hive memory:`
  line in the precedent and the item's `hiveSync` field. A failed or
  timed-out write (20 s) never fails the answer: it is logged, and the page
  marks the answered row "not in hive memory". `comb precedents sync`
  backfills and retries every precedent not yet queued, idempotently.
  hive's nightly may later promote lasting ones into taste.
- **D14. Three places: session, Maya, page** (2026-11-11, §1). Greg
  addresses agents by name from his session; his session offers hand-offs
  and never takes them on its own.
- **D15. comb's page is its own server, and it can message agents**
  through the one-shot relay (§9).
- **D16. comb is an agent tool, not a command for Greg** (2026-11-11).
  `comb-mcp` is registered for Greg's sessions at user scope.
- **D17. Agents are a roster; state is comb's problem** (2026-11-11). Greg:
  "We should just have a list of agents that can do stuff." Callers never
  check whether an agent is alive. `agent_send` reaches it either way: a live
  agent through the relay, an asleep one (retired by the daemon, stopped, or
  crashed) by resuming it with the message as its prompt. It also reaches
  any open session by name, so replies use the same verb. `agent_list` shows
  only working or ready. Verified live: a stopped Maya woke on `comb send` in
  1 second and replied to Greg's session through `agent_send`.

- **D18. The page is one live screen; a transcript is the conversation**
  (2026-11-11, §9.1). Greg: the hive dashboard is "too busy and long" and
  "not interactive". Light first. Messages from the page are read back from
  the agent's transcript rather than routed as replies.

- **D19. Asks are filed, not inferred** (2026-11-11, §9.2). The page shows
  what agents put in the queue with `queue_add`; it never reads proposals out
  of their prose. Greg: "click a button and say, yeah, that's a good idea, go
  do it."
- **D20. Each agent's model is a setting** (2026-11-11). `settings.json` in
  the workspace (`{"model": "opus"}`), passed as `--model` on every start and
  wake. Maya runs on Opus. Before this, agents got Claude Code's default and
  Maya was running on Fable.
- **D21. One task agent per job, not one agent per project** (2026-11-12,
  §3). Greg: "keeping a strong context window is very important... spawn up a
  new agent with the context necessary to do the work." A project's lasting
  context is in files (hive memory, tickets, branches, reports), so a
  long-lived project agent would only gather stale turns. The cost is a cold
  start per job, so small things (a memory note, a ticket update) Maya does
  herself. Found when Maya's queue items named `docs-site-71`, Greg's own
  CLI session, as the docs-site agent.
- **D22. Finished agents fold; they are never deleted** (2026-11-12, §9.1).
  Greg asked whether old sessions age off. They did not: a finished agent
  keeps its workspace and session so a message wakes it (D17), and the tree
  only grew. Now a task agent with a report and 7 idle days folds into a
  collapsed Finished group, and Greg's sessions fold after 7 idle days. Maya
  never folds, and a parent with a child still in the list stays. The rule is
  a pure function on the snapshot (`foldedAgents`, `sessionFolds`), so the
  page only renders it. A report is the signal for "finished" because an
  agent with no report has not handed anything back yet.
  - 2026-11-15: the window is one day, not seven, for agents and for Greg's
    sessions; `foldAfterHours` in `~/.comb/config.json` changes it. Greg,
    looking at 20 task agents under Maya, most finished 1–3 days ago:
    "should we hide Maya agents under Maya that are more than one day
    old... or maybe hide stuff that's over one day old if this list gets
    larger than twelve or so." A flat rule, not a count threshold: with a
    threshold, the list would change shape when the 13th agent appears.
    Siblings now sort working first, then by last activity, newest first,
    in place of alphabetical order.
- **D23. hive's nightly picks and asks are filed into the queue by comb, on
  the page server's hourly timer** (2026-11-13, §9.3). Greg: "Put hive's
  nightly Act picks and briefing asks in the comb queue." comb reads hive's
  files and hive never learns comb exists, which keeps D10's one-way
  boundary. This is the one place comb parses prose (the briefing's list),
  and it does so only to file a decision Greg answers; D19 still holds for
  agents. The trigger is a timer in the page server, not a launchd job after
  hive's: hive's picks land at varied hours (Act watches ran at 00:25 and
  01:30 on 2026-11-13) and its nightly retries at 08:30 and 12:30 when the
  laptop slept, so a fixed run time would miss some nights. The page server
  is already a KeepAlive login service; an hourly, idempotent check catches
  whatever hive wrote within the hour and needs no second plist. The cost:
  no page server, no filing, which is the same condition under which Greg
  could not see the queue anyway.
  - 2026-11-15: briefing asks are off by default; `nightlyAsks: true` in
    `~/.comb/config.json` turns them back on, and the parsing code stays.
    The asks come from Greg's own sessions (essay edits, fact checks). He
    declined two in a row ("Part 3 contradiction", "Part 1 publish
    blockers") and said: "Not sure I want decision stuff from ongoing
    sessions like this." Act picks are unchanged: same caps, the 7-day
    rule, the stale and closed skips.

- **D24. comb runs on plain Claude Code; hive is the recommended adapter**
  (2026-11-14, `docs/standalone-decision.md`). Greg: "if hive is installed, I
  want comb to use that. I want all my personalization and tickets and such.
  ... But I do want comb to be able to attach to claude code generic, and I
  think the README should specify the dependence on hive for best results."
  `detectHive` (`src/hive.ts`) decides once per process: `auto` needs the
  `hive` CLI (PATH, then `~/.local/bin`) and `~/.hive`; `hive` in
  `~/.comb/config.json`, or `COMB_HIVE`, pins it `on` or `off`. With hive,
  every hive path works as before: the same `hive identity emit` argv, project
  names, tickets, memory, nightly (D23), `hive attach`. Without it: identity
  from `identityFile`, else `~/.comb/identity.md` (seeded by `comb init`),
  else `templates/identity.md` bundled in the binary; the preamble drops
  hive's tools, TRUST.md and council; Tickets and Memory say to install hive;
  nightly is off; Open in terminal runs `claude attach`. No ticket system in
  comb: a second tracker would compete with hive's, and agents already take
  work from charters and the queue. The human's name comes from
  `userName` everywhere comb writes it (preamble, page signature, ticket
  starts, comb-mcp's tool text, Maya's charter at init); the internal id stays
  `greg`, so stored state needs no migration. The hand-off skill is a static
  file linked into `~/.claude/skills`, so it says "the user". The transcript
  parser reads any "<Name>, on the comb page:" and the original "Greg, on the
  comb page:" as before. Still open: `hive attach` lives in hive and reads
  `~/.comb`, which D10's one-way rule forbids; moving it into comb as
  `comb attach` is separate work.

- **D25. Greg picks the model when he delegates, on the Go button**
  (2026-11-15, §9.2). Greg: "When I'm in my own sessions, I'll select the
  models, but this is only to deal with when I'm telling Maya to delegate
  something ... or do the model picker when it's on the dashboard things
  waiting on me part." His normal is Opus, so `defaultModel` (config.json)
  defaults to opus and agent_start uses it when no model is named; that is
  now saved to settings.json like a named one (D20), so every agent runs on
  a known model and keeps it on wakes. The aliases are one list in
  `src/models.ts`, so a new model is a one-line change, and queue_add and
  config.json accept only those. No picker in the agent header: Greg picks
  only when delegating. A review gets the picker only when its filer set a
  model, because only then does its go start an agent.

- **D26. The page patches; it never rebuilds under the reader** (2026-11-15,
  §9.2). Greg, typing a "Not now" note: "the focus goes away ... we should
  never lose focus when we have it", and the note arrived cut short ("Not
  focu"). Then: "the page moves and the focus moves and everything." Cause:
  the Now page replaced `#now-queue`'s innerHTML whenever its markup
  changed, and the "4m ago" tags changed it every minute. Fixed by keyed
  patching, carrying the focused node, leaving time text out of the diff,
  holding the reader's place by hand (`overflow-anchor: none`, so Chrome and
  Safari behave the same), and holding arrivals behind a pill. The side
  chat composer and the memory filter are built once, so they never had the
  problem.

- **D27. A fresh start replaces the conversation, not the agent**
  (2026-11-15, §6). A resumed conversation keeps the tool schemas it loaded
  at its first start, so after a comb upgrade an agent never sees new tool
  fields: Maya could not pass `model` to agent_start or queue_add although
  the installed comb-mcp listed both. `agent_start` takes `fresh` (and
  `comb start` takes `--fresh`): no `--resume`; the agent gets the restart
  prompt (charter, checklist, memory/, the end of log.md), session.json
  records the new session, and log.md says "restarted fresh". A live session
  with the name is stopped first, so two sessions never share a name; the
  stop comes after every other check, so a failed start leaves the old one
  running. The default stays resume: history is worth keeping, and fresh
  costs the agent its conversation. agent_start refuses a fresh start of the
  calling agent itself, because the stop would end the call; Greg runs
  `comb start <name> --fresh` for that.
- **D28. comb's status-line tee is the one change to global Claude config**
  (2026-11-17, §9.1). Greg wants his plan limits on the page ("I care most
  about my limits") and no third-party app in the path. Claude Code hands
  them only to the statusLine command, so comb wraps the status line:
  `statusLine.command` in `~/.claude/settings.json` becomes `comb statusline`,
  which saves `rate_limits` (and nothing else from stdin) to
  `~/.comb/cache/rate-limits.json`, then runs the old command under `/bin/sh`
  with the same stdin and env and passes its stdout, stderr and exit code
  through. The reading is saved before the old command starts, so a slow or
  killed status line never loses it. An old command that no longer exists
  shows nothing and is logged once an hour; with none, the tee prints
  nothing. `COMB_STATUSLINE=1` in the wrapped command's env stops a loop.
  Only on the user's yes: `comb init` asks in a terminal and otherwise only
  says how; `--install-statusline` is the yes, `--undo-statusline` restores
  the old `statusLine` object (kept in `~/.comb/statusline.json`) and
  refuses if someone has changed it since. `comb init`'s steps (scaffold,
  page service, status line) each run whatever the others did, and the
  command exits non-zero naming what failed: on 2026-11-17 launchctl's
  bootstrap race (exit 5) had stopped init before the status-line step. Only the command changes; other
  keys (`padding`, `refreshInterval`) stay, and settings.json is backed up to
  `~/.comb/backups/` before every write. The page reads settings.json to warn
  when the tee is gone (another tool may rewrite the status line). Cost,
  measured over 50 runs against a no-op old command: 34 ms at p50 and 55 ms
  at p95 over running the old command alone, all of it comb's startup. The
  rule "never change global Claude config" keeps holding for everything else.
- **D29. The page service runs comb through /bin/sh, and init restarts it in
  place** (2026-11-18, TK-006). Every reinstall showed macOS's "'comb' can
  run in the background". backgroundtaskmanagementd's log gives the cause.
  When launchd rescans LaunchAgents, BTM re-checks each item. If the plist or
  the program changed, it compares the program's code requirement (LWCR).
  The same LWCR keeps the item as notified, with no toast. A new LWCR marks
  it as not notified, and the toast follows. comb's binary is ad-hoc signed,
  so its requirement is its cdhash. Bun's builds are not even reproducible,
  so every build is new code. Re-signing with a fixed `--identifier` does not
  help: tested, and BTM still logged a new item. So the plist runs
  `/bin/sh -c 'exec "$0" "$@"' ~/.local/bin/comb page ...`, the way hive's
  agents run `/bin/bash`. /bin/sh is Apple-signed and never changes. Login
  Items and the toast name the item "sh". The switch itself shows one last
  toast. Separately, `comb init` leaves an unchanged plist untouched: a
  rewrite with the same bytes still triggers a rescan. In that case init runs
  `launchctl kickstart -k`, which restarts the running service on the new
  binary. A kickstart failure falls back to bootout and bootstrap, and init
  says so. The bootstrap is retried once for the exit-5 race. Not fixed here:
  "'comb' was prevented from modifying apps". TCC named comb as the
  responsible process of a Google Chrome that the page's children launched.
  Because comb's cdhash changes, a stored answer never matches. Only a stable
  signing identity (a real certificate) fixes that.

## 11. Open questions

- **Q1. Where does the work loop stop for Greg?** After design, only at the
  reviewable branch, or by the size of the change?
- **Q2. (Answered 2026-11-11.)** The page reaches agents through a one-shot
  `claude -p` relay (§9).

## 12. Build order

1. **Agents.** (Done 2026-11-11.) Workspaces, `comb start|list`, comb-mcp
   with `agent_start` and `agent_list`, verified live end to end.
2. **Skills.** Move the core contract into a file; write the work-loop skill
   with Greg (Q1); write `comb-handoff` for Greg's sessions; spike
   `--plugin-dir` with `--bg` (§5.3); give `agent_start` a skills choice.
3. **The page, first cut.** Agents and Greg's own sessions with live state,
   and a message box per agent through the relay.
4. **Supervision.** Exit and hang detection reaches the parent; restart from
   the workspace.
5. **Maya and task agents.** (Done 2026-11-12.) Maya starts one task agent
   per job (D21).
6. **Queue and precedents.** `queue_add`, `precedents_search`, Waiting and
   Reports on the page.

## 13. Claude Code facts (verified)

Claude Code 2.1.319–2.1.322, real background sessions.

| Question | Result |
|---|---|
| Start | `claude --bg -n <name> "<prompt>"` returns at once and prints `backgrounded · <id> · <name>` |
| Auth | Subscription, with no API key in the environment |
| Flags with `--bg` | `--append-system-prompt-file`, `--mcp-config`, `--permission-mode` and `-w` all work |
| `--mcp-config` | Takes a list: a prompt right after it is swallowed as a config path, and the session starts idle and fails. Put a single-value flag after it |
| Trust | `--bg` refuses a folder Claude has not trusted. Agents start only in repos Greg has opened in Claude |
| Identity via hook | Arrives only as a preview file, and a session started from a hive session inherits `HIVE_IDENTITY_IN_PROMPT=1` and gets none. So comb injects identity itself |
| Message a live session | `SendMessage` by session name delivers, agent to agent included |
| `--resume` on a live session | Starts a copy. Never use it for delivery |
| Resume a dead or finished session | `claude --bg --resume <id>` wakes the same session with its history |
| Status | `claude agents --json` lists live sessions; a finished one stays as `done` until `claude rm`. (2026-11-12) A finished turn can also show `done` with a pid and `status: idle`, process still alive. A `--resume` then makes a second session with the same name, and SendMessage refuses the ambiguous name, so comb runs `claude stop` on it before any wake |
| Failed at start | Appears only under `--all`, as `failed` |
| Killed | Leaves the live list within 8 seconds; under `--all` it looks like a clean finish (`done`, no pid). The report file is the only difference |
| Idle notice | `notify_when_idle` reports a finished turn, a few minutes late. A killed session sends nothing; the subscription expires after 12 hours |
| `-w <name>` | Creates `<main checkout>/.claude/worktrees/<name>` on `worktree-<name>`, from the main checkout's HEAD, even from another worktree. `claude rm` removes a clean worktree and branch |
| Mode tag | Messages have arrived tagged `from-mode="prompting"` although both transcripts record `auto`, and were not held. Watch it if messages stall |
| comb-mcp tools | Deferred: the agent loads them with one ToolSearch call |
| Between messages | A background agent finishes its turn and waits (`state: blocked`, `status: idle`). The next `SendMessage` continues the same session with its full history: Maya answered a follow-up from context without re-reading (2026-11-11) |
| Idle retire | The daemon retires a background session after 3 hours at an idle prompt (`daemon.log`: `bg retire <id>: idle-prompt, idle 3h`). `claude agents` then keeps its last state (`blocked`) with no status and no pid, and SendMessage cannot reach it. `--resume` brings it back under a new session id with the old transcript copied in. comb treats a background row with no status as ended (2026-11-11) |
| Same-name MCP servers | An agent's `--mcp-config` `comb` entry wins over the user-scope one |
| `claude attach <name>` | Opens a background session in the terminal; part of the name works. Detaching (←, Ctrl+Z) leaves the session running (2.1.323) |
| Rex CLI | Not on PATH. It lives at `/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`; `rex __internal skill` prints its guide. A tab is `rex window new -s <session> <label> -c <dir> --keep-open --json -- <argv>`; a session is `rex new <label> -c <dir> --window <label> --json -- <argv>`. Neither shows anything in the app: `rex -C <app client> do session.select session_id=… window_id=…` does. `--autostart=false` fails instead of starting a hidden server. Commands run in the login shell's environment, so `claude` resolves (Rex 0.0.1793299046, 2026-11-12) |
| One-shot relay | `claude -p` with only `SendMessage` allowed delivers to a live session by name in about 5 seconds. `--allowedTools` takes a list too, so send the prompt on stdin |

## 14. Sources

- Brian Armstrong's post (leads, chief of staff, one queue).
- Claude Code docs: skills, sub-agents, agent view, cross-session messaging,
  plugins.
- The `hive-v2` branch of the hive repo: the design history, the watches
  removal, and the spike.
