# comb — Design

**Status:** living design. Step 1 is built.
**Started:** 2026-11-07 as "HIVE v2" (branch `hive-v2` in the hive repo).
Became comb on 2026-11-11.

## 1. What comb is

Greg is the bottleneck. Today every idea needs him through the whole loop:
think, research, design, implement, test, review. comb exists so he can hand
that loop off, get the idea across, and then manage, nudge and guide
direction instead of writing a design doc and iterating every time.

comb is a small supervision tree of long-lived Claude Code agents, with what
needs Greg gathered in one place.

**comb is a layer on top of hive, not a new version of it.**

| | hive | comb |
|---|---|---|
| Is | The personalization layer | The work layer |
| Answers | Who you are, what you know | Who is working on what |
| Owns | Identity, memory, taste, tickets, council, nightly pipeline | Agents, the tree, skills for agent roles, the queue, precedents |
| State | `~/.hive` | `~/.comb` |

comb reads hive through stable interfaces and never writes `~/.hive`:

- **Identity:** `hive identity emit`, run in the agent's directory, so it
  carries that project's memory index and stack hint.
- **Projects:** the registry files `~/.hive/projects/<name>/config.md`.
- **Memory and tickets:** the `hive` MCP server, which every Claude session
  already loads. Agents read and write project memory and tickets there.

Nothing in comb merges back into hive. There is no cutover.

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
  waiting on me in revrec?" His session relays that to Maya with
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

One concept: an **agent**, a long-lived Claude Code background session with
its own workspace, a charter, skills and a parent. The tree is who started
whom.

```
Greg
 └─ Maya, chief of staff          (charter: look across everything)
     ├─ revrec                    (charter: the revrec project)
     │   ├─ rate-limiter          (charter: build TK-142, own worktree)
     │   └─ reviewer              (charter: review rate-limiter's branch)
     ├─ matreas                   (charter: the matreas project)
     └─ release-notes             (started by Maya directly)
```

- **Maya** is the chief of staff at the top. She thinks across everything:
  conflicts, duplicated work, shared blockers, priorities.
- **Project agents** sit under Maya, one per project on an explicit list
  (D5). Each starts with its project's hive context.
- **Any agent can start children.** A child lives as long as it is useful,
  can be messaged later, and can start its own children.
- **An agent ends** when its parent decides it is done.
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
| **Project** | Project agents | Ticket workflow, starting builder and reviewer children, proposals as small bets. Stack skills come from the repo (`hive stack`) |
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
its history survives.

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

## 10. Decisions

- **D1. Maya is a background Claude Code session on the subscription.**
  Greg opens her with `comb maya` or messages her with `SendMessage`.
- **D2. Claude Code only, for now** (2026-11-11). Other harnesses read the
  same `SKILL.md` format and can come later; a message bridge is needed only
  across harnesses.
- **D3. Recovery is from the workspace.** Agents keep what matters in
  `log.md` and `memory/`, not in context.
- **D4. Watches and campaigns are deleted** from hive (hive PR #41).
- **D5. Project agents come from an explicit list.** Six to start: matreas,
  revrec, arete, writing, investing, hive.
- **D6. Messages ride the harness** (2026-11-10). No comb `message` tool.
  All comb agents run in one permission mode (`auto`, override with
  `COMB_PERMISSION_MODE`), because Claude holds messages between sessions in
  different modes for approval.
- **D7. Supervision works like an Erlang supervision tree.** A parent learns
  when a child exits or hangs. Silent death is a signal, not silence.
- **D8. Incoming messages ride the harness.** Busy-session behavior is
  Claude Code's.
- **D9. No driving mode.** Greg's sessions stay outside the tree and talk to
  Maya. He can still `claude attach` to watch any agent.
- **D10. comb is its own tool on top of hive** (2026-11-11). Separate repo,
  binary, state (`~/.comb`) and MCP server (`comb-mcp`). It reads hive and
  never writes `~/.hive`. Supersedes "hv runs beside hive until cutover."
- **D11. Subscription-only auth.** Every agent start removes
  `ANTHROPIC_API_KEY`; if OAuth fails, the start fails visibly.
- **D12. Skills define roles** (2026-11-11), delivered per session (§5.3).
  The work-loop skill comes first.
- **D13. Precedents live in comb for now.** They are tied to queue answers;
  hive's nightly may later promote lasting ones into taste.
- **D14. Three places: session, Maya, page** (2026-11-11, §1). Greg
  addresses agents by name from his session; his session offers hand-offs
  and never takes them on its own.
- **D15. comb's page is its own server, and it can message agents**
  through the one-shot relay (§9).
- **D16. comb is an agent tool, not a command for Greg** (2026-11-11).
  `comb-mcp` is registered for Greg's sessions at user scope.

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
5. **Maya and the six project agents.** `comb maya`; project agents from
   the list.
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
| Status | `claude agents --json` lists live sessions; a finished one stays as `done` until `claude rm` |
| Failed at start | Appears only under `--all`, as `failed` |
| Killed | Leaves the live list within 8 seconds; under `--all` it looks like a clean finish (`done`, no pid). The report file is the only difference |
| Idle notice | `notify_when_idle` reports a finished turn, a few minutes late. A killed session sends nothing; the subscription expires after 12 hours |
| `-w <name>` | Creates `<main checkout>/.claude/worktrees/<name>` on `worktree-<name>`, from the main checkout's HEAD, even from another worktree. `claude rm` removes a clean worktree and branch |
| Mode tag | Messages have arrived tagged `from-mode="prompting"` although both transcripts record `auto`, and were not held. Watch it if messages stall |
| comb-mcp tools | Deferred: the agent loads them with one ToolSearch call |
| Same-name MCP servers | An agent's `--mcp-config` `comb` entry wins over the user-scope one |
| One-shot relay | `claude -p` with only `SendMessage` allowed delivers to a live session by name in about 5 seconds. `--allowedTools` takes a list too, so send the prompt on stdin |

## 14. Sources

- Brian Armstrong's post (leads, chief of staff, one queue).
- Claude Code docs: skills, sub-agents, agent view, cross-session messaging,
  plugins.
- The `hive-v2` branch of the hive repo: the design history, the watches
  removal, and the spike.
