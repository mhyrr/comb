# Standing mandates: agents that work an area while Greg is away

**Status:** proposal, for Greg's review. Nothing here is built.
**Date:** 2026-11-28.
**Author:** comb-mandates-design, a Fable session. Section 5 compares Fable
with Opus, so read that section knowing who wrote it. The experiment there is
built so that my opinion does not decide the result.

**How Greg will know it worked:** he leaves for three days. When he comes
back, one page tells him what landed, what each landing's revert is, what
waits on him, and what broke. Nothing on that page turns out to be wrong.

## 1. The problem, with this week's numbers

Greg's correction is right: comb has many agents, and almost all of them run
because he started something. I checked where the time goes.

| What I measured | Result | Source |
|---|---|---|
| Greg's answers so far | 90: 63 Go, 20 Not now, 7 Redirect | `~/.comb/precedents/` |
| comb and hive answers | 36: 33 Go, 1 Not now, 2 Redirect | same |
| Wait for an answer, all items | median 14.8 h; 23 of 90 over 24 h | queue `created` to precedent `When` |
| Wait for an answer, proposals | median 21.8 h; 15 of 40 over 24 h | same |
| Wait for an answer, comb and hive | median 1.6 h; 5 of 37 over 24 h | same |
| Longest PR wait this week | 67 h (comb #27 and hive #51, 11-25 to 11-28) | `gh pr list --state merged` |
| Nightly failures on battery | 11-23 (all three tries, no canon), 11-27 (02:04 try; the 08:30 retry passed) | `~/.hive/logs/nightly.log` power lines |
| Merge permission rule | Greg said Go on 11-24. The rule is not in `~/.claude/settings.json` today | read 2026-11-28 |
| Stale tickets right now | comb TK-011 is in_progress and its PR merged today. hive TK-150 is open and its PR merged 11-21. hive TK-152, TK-015, TK-021 and TK-105 are about watches, which were deleted 11-23 | hive ticket list |
| A dead job still loaded | `com.hive.watches` exits 1 at every firing | `launchctl list` |

Three readings.

1. **Greg's Go on upkeep carries little information.** 33 of 36 is 92%. The
   two redirects widened the work; neither stopped it. His Not nows elsewhere
   are about focus ("Not focused on this right now", "Does not seem a
   priority"), not about quality. A mandate states the focus once, in advance.
2. **When Greg is around, upkeep is fast already** (median 1.6 hours). The
   mandate pays when he is away. So the measure is work that finished while he
   was away, and persistence comes before autonomy.
3. **Things rot without anyone deciding to let them.** A stalled agent for
   3.5 days, six finished tickets left open, reminders lost on a restart, a
   Go that never became a config change. No approval is missing in these
   cases. A clock and a checklist run by code are missing.

Greg's framework fits this: Coase's theory of the firm. Each Go click is a
transaction cost, a spot contract for one job. A firm exists where direction
inside standing authority is cheaper than pricing each transaction. A mandate
is that move. The same theory gives the limit: the firm stops growing when
monitoring costs as much as the transactions it replaced. Greg's monitoring
capacity (reading reports, trusting verdicts) bounds the number of mandates.
That is why this doc puts its weight on verification and on the report, and
why "hundreds of agents" is out of scope.

## 2. Where I disagree with Maya's proposal

Maya's outline is the starting point, and most of it stands. Five changes.

1. **"How much moved without Greg starting it" is the wrong measure.** It
   counts starts. An agent that opens twenty PRs scores well and makes Greg's
   week worse. The measure I propose: changes that landed without Greg and
   still stand a week later, divided by the minutes Greg spent on the mandate.
   Started-without-Greg stays as a secondary count.
2. **The schedule is not "cheap plumbing" to add later. It is step one.** Both
   nightly failures this week ran on battery, and hive-tk-163 froze when the
   laptop slept. A mandate on a machine that sleeps covers the hours Greg is
   at the desk, which is what we have today.
3. **Greg asked "elevate scope, or scheduled jobs?" Both, as two layers.** The
   wake is the clock. The mandate is what an agent may do when the clock
   ticks. A wake without a mandate makes more cards (morning proposals: 3
   filed, 3 Go, each still waiting for a click). A mandate without a wake does
   nothing at 03:00.
4. **Merge rights matter less than they look.** I ran the proposed gate over
   the last 28 merged PRs in comb and hive (§4.3). It would have landed 6.
   Most PRs touch the code that starts, wakes and supervises agents, and that
   code stays Greg's. Merge rights are worth having. They will not be where
   most of the gain comes from.
5. **The mandate holder is not a long-lived conversation.** D21 dropped
   project agents because a long conversation gathers stale turns. The holder
   is a workspace plus a fresh session at each wake (§3.3).

## 3. The mandate

### 3.1 Format and where it lives

`~/.comb/mandates/<name>/mandate.md`. `key: value` lines between `---`
fences, then prose, the same shape as a queue item. Greg can read and edit
it. It lives in comb, not hive: it names agents and the queue (the layering
rule of 2026-11-24). Without hive it works with charters and the queue, and
the ticket lines are left out.

| Field | Meaning |
|---|---|
| `name`, `status` | `status` is `shadow`, `active`, `paused` or `expired` |
| `goal` | One sentence |
| `measure` | Lines a script or a person can check each week |
| `area` | Repos and hive projects it covers. Everything else is outside |
| `holder_model`, `builder_model`, `verifier_model` | Model per seat (§5) |
| `wake` | Times of day the holder wakes |
| `budget_week_usd` | API-equivalent dollars a week for the holder and its children, from comb's usage index |
| `brake` | Weekly and session limit percentages above which the holder starts no new work |
| `may` | What the holder does and tells Greg in the report |
| `lands_when` | The gate for merging without Greg (§4.2) |
| `protected_paths` | Globs that always go to Greg |
| `asks` | What always goes to the queue |
| `report` | Day and time of the weekly report |
| `review_by` | The date it expires unless Greg renews it |

Folder contents:

```
~/.comb/mandates/upkeep/
  mandate.md        the grant (Greg's; agents never edit it)
  approved.json     hash of the text Greg approved, and when
  state.md          the holder's working notes between wakes
  ledger.jsonl      one line per action taken under the mandate (written by code)
  reports/          2026-W49.md, ...
```

Three rules give it a way back, because a grant needs one from the first
version (taste: design the undo with the action).

- **Approval is by hash.** The page shows the mandate with an "Approve this
  version" button and records the text's hash in `approved.json`. Code that
  acts on the mandate refuses when the file's hash differs. An agent that
  edits the mandate switches its own rights off until Greg approves again.
  This catches drift and accidents. It does not stop a hostile process, which
  runs as the same user; Claude Code's own permission checks are the layer
  for that.
- **It expires.** `review_by` is one week out at first. The weekly report
  carries one card: "Renew upkeep for another week?" If Greg is away for
  three weeks, autonomy lapses instead of compounding.
- **Pause is one click** on the page. The next wake does nothing, and nothing
  lands.

### 3.2 The example: hive and comb upkeep

```
---
name: upkeep
status: shadow
goal: hive and comb keep working without Greg tending them.
area: repos mhyrr/comb, mhyrr/hive; hive projects comb, hive
holder_model: fable
builder_model: opus
verifier_model: fable
wake: 07:30, 13:00, 19:00
budget_week_usd: 40
brake: weekly 60, session 50
report: Monday 08:00
review_by: 2026-12-08
---

## Measure (checked every week)
- The hive nightly completed every night it had power, under $3 a night.
- No agent sat stalled for more than 12 hours without a note in the ledger.
- No ticket is open or in_progress when its PR merged more than a day ago.
- The comb page answered at every wake.
- No wrong claim reached Greg. Each correction is counted.

## May, and tells Greg in the report
- Start task agents on open comb and hive tickets that are bugs, chores,
  docs or tests, P2 or higher, one at a time per repo.
- Nudge or restart a stalled agent. Close a ticket whose PR merged, with the
  link. Withdraw a card whose work is done. File tickets.
- Remove a merged worktree, after checking it has no open card.

## Lands without Greg when all hold (off while status is shadow)
- The PR is in the area and came from a ticket in the area.
- The code gate passes (comb land, §4.2).
- An independent verifier's verdict is "pass" for the PR's head commit.

## Protected paths: always Greg
- comb: src/agents.ts, src/claude.ts, src/mcp-server.ts, src/queue.ts,
  src/nightly.ts, src/cli.ts, src/hive.ts, src/page/server.ts,
  src/page/answer.ts, src/page/service.ts, templates/, anything that reads
  or enforces a mandate.
- hive: the nightly pipeline (orchestrator, extract, verify, apply, claude),
  src/mcp-server.ts, templates/, scripts/, anything under ~/.hive.

## Always the queue
- Design changes. New features. Anything outside the area.
- Installs (stage 3 changes this). Paid model calls. Anything external other
  than a push or PR in the area's repos.
- Any change to this mandate, a charter, TRUST.md or a permission setting.
```

The backlog it would start on: TK-163 (nightly failures, the PR is still
owed), TK-118 (embed templates; Greg's Go is already given), the stale
tickets in §1, the dead `com.hive.watches` job (unloading it is an install-
class action, so it is a card), and nightly cost (TK-131, TK-168).

### 3.3 The holder

One agent per mandate, named for it (`upkeep`), a child of Maya.

- **Each wake is a fresh session** started from the workspace (D27's `fresh`),
  with a wake packet as its prompt. Its memory is `state.md`, the ledger and
  the tickets. This keeps D21's reason intact, survives sleep and restarts,
  and makes the holder's model a field that can change between wakes.
- **The wake packet is computed by code** (Greg's rule: LLMs interpret, code
  computes). It holds: the mandate; budget used this week; the limit
  percentages and whether the brake is on; agents in the tree with their
  state and last-activity age; open PRs in the area with age and check
  status; tickets whose PR merged; open cards; missed wakes since the last
  one; the tail of the ledger.
- **The holder decides what to do with it.** It may do nothing. A wake that
  ends "nothing needs me" is a correct result and costs one small read.
- **Maya stays Greg's address.** She receives the weekly report, relays
  Greg's words to the holder, and is not in the merge path.

## 4. Trust tiers and verification

### 4.1 Tiers

| Tier | What | On what evidence | Greg hears |
|---|---|---|---|
| 0. Any agent, today | Read, branch, commit, push own branch, open a PR, write tickets and memory | None | The PR or report |
| 1. Acts | The mandate's "May" list | The fact it rests on, written in the ledger (the merged PR's link, the log's age) | Weekly report |
| 2. Lands | Merge a PR in the area | Code gate and independent verifier, both on the head commit | Ledger at once, weekly report, with the revert command |
| 3. Asks | Everything in "Protected paths" and "Always the queue" | The agent's case | A queue card |
| Never | TRUST.md's hard limits | — | — |

Widening is Greg's edit. After a category has ten clean landings and no
revert, the holder may file one card with the tally and the proposed line.
design.md already says it: "Trust is earned later, deliberately."

### 4.2 Landing: a code gate and an independent verifier

Two checks of different kinds. Neither is the builder.

**The code gate, `comb land <pr>`.** A comb command. It reads the mandate and
checks, in code:

1. The mandate is approved (hash), `active`, unexpired, and under budget.
2. The repo is in the area. The PR's branch belongs to an agent in the
   mandate's tree.
3. The diff is at most 400 changed lines (tests and `.md` files not counted).
4. No changed file matches `protected_paths`.
5. GitHub reports the PR mergeable, and its checks, if any, are green.
6. A verdict file exists for this PR, says `pass`, and names the PR's current
   head commit. A push after the verdict voids it.
7. Greg's local main is not ahead of origin (the 11-20 lesson: a GitHub merge
   then diverges his checkout).

If all hold, it runs `gh pr merge --squash`, appends the merge commit and the
revert command to the ledger, and prints both. If any fails, it prints which,
merges nothing, and the PR goes to Greg as today.

The thresholds are in the mandate file. The code holds no opinion about them
(CLAUDE.md: opinions live in files).

**The verifier.** A fresh agent per PR, started by the holder from a fixed
template, `templates/verifier-charter.md`. The holder cannot reword it.

- It receives the PR number, the ticket text and the mandate. It does not
  receive the builder's report or the holder's view. It reads the PR body
  last, as a list of claims to test.
- It works in its own detached checkout of the head commit and cannot push.
- It must: run the repo's checks itself and save the output; read the whole
  diff; say whether the diff does only what the ticket asks; reproduce each
  user-visible claim in the PR body (the 11-25 lesson: the plist claim was
  checked with `plutil`, and the claim about launchd's behaviour was not);
  design and run at least one check meant to break the change.
- It writes `verdict.md`: `pass`, `fail` or `cannot tell`, the head commit,
  and for each claim the command it ran and what it saw. `cannot tell` is a
  normal answer and sends the PR to Greg.
- Its model is the one the builder did not use. Different models make
  different mistakes, and that is cheap independence.

### 4.3 The gate, run against the last 28 merged PRs

I applied rules 3 and 4 to comb #14–#27 and hive #38–#51.

| | Would land | Would go to Greg | Why most go to Greg |
|---|---|---|---|
| comb | 4 (#14, #16, #18, #19) | 10 | 8 touch `agents.ts`, `server.ts`, `queue.ts` or `service.ts`; 2 are over 400 lines |
| hive | 2 (#42, #46) | 12 | Nightly pipeline, templates, or size |

Six of 28. This is the honest size of merge rights for this mandate: page
work, usage and tools panels, docs, small fixes. I recommend keeping the
protected list as it is. This mandate's agents maintain the system that
supervises them, and a bad merge to the wake path can break the thing that
would notice the break. The list can shrink by Greg's edit as landings stay
clean.

### 4.4 Claims that reach Greg

The three wrong claims this week ("init wipes retries", "launchd refuses
both", "promo excludes Claude Code") were statements about how a system
behaves, made in a proposal or in chat. None was a builder's report, and a
merge verifier would have caught none of them.

The rule, for the holder's charter and the report template: each factual
claim in a card or a report carries one of three words. **Saw** (ran it and
observed; the command is named), **read** (the code, with path:line), or
**inferred**. An inferred claim about behaviour may not be the reason for a
card. "Unverified" passes up word for word, as now. Each correction Greg or a
later check makes is counted in the report.

### 4.5 The merge permission: Greg's change

What the docs say (code.claude.com permission-modes and permissions pages,
read 2026-11-28 through a docs sub-agent):

- In auto mode, a narrow allow rule resolves before the classifier runs. A
  broad rule such as `Bash(*)` is dropped.
- `--settings <file>` is a settings source, `permissions.allow` is honored
  from it, and `claude --bg` carries the flag to the background session.
- Rules match command text, not arguments. A PreToolUse hook is the
  documented way to check arguments, and a hook's `deny` holds in every mode.
- `autoMode` is honored only from user or managed settings.

What I saw on this machine: `permissions.allow` holds `Bash(git merge
--ff-only *)` and no rule for `gh pr merge`. The `autoMode.environment` text
names one trusted repo, `/Users/mhyrr/work/dobby`. I infer that this text is
part of why the classifier refuses merges in comb and hive. Unverified.

The grant I recommend:

1. comb passes a per-agent settings file at start: `--settings
   ~/.comb/agents/<name>/claude-settings.json`. Only the holder's file holds
   `"allow": ["Bash(comb land *)"]`. No other agent, and none of Greg's
   sessions, gets it. Nothing global changes.
2. Nobody gets `gh pr merge`. The only way to merge is `comb land`, and its
   code enforces the mandate. The grant is a narrow door, and Greg has
   reviewed the door's code because it sits on a protected path.
3. Greg creates the first settings file himself, or approves it on the page.
   An agent does not write its own permissions (Maya refused this correctly
   on 11-24).

Unverified, to test in a scratch HOME before relying on it: that a
`--settings` allow rule skips the classifier for a `--bg` session, and
whether a compound command defeats the match. If it does not hold, the
fallback is the same rule in `~/.claude/settings.json`, which is wider: every
session could run `comb land`, and the gate would still check the mandate.

## 5. Persistence

### 5.1 The wake

A launchd job, `com.comb.wake`, with calendar times (07:30, 13:00, 19:00 for
upkeep). It runs `comb wake` through `/bin/sh` (D29, so reinstalling raises
no toast; adding the job raises one, once).

`comb wake` does this, in code:

1. Writes a heartbeat line to `~/.comb/wake/heartbeat.jsonl`: time, power
   source, what it did.
2. On battery, it stops there and records "skipped: on battery". hive's
   memory says macOS honors a `caffeinate -s` hold only on AC (the August
   nightly failures). I did not re-test that.
3. Compares the heartbeat with the schedule and records missed wakes.
4. Runs the health pass (§5.2).
5. For each approved, active mandate that is due, builds the wake packet and
   starts the holder fresh. It holds a `caffeinate -s` assertion while any
   agent in the mandate's tree is on a turn, for at most 90 minutes.
6. Delivers due reminders (§5.3).

Three wakes a day is a start. Stall detection does not depend on them: the
page server's hourly timer also runs the health pass.

### 5.2 Stall detection without anyone remembering

design.md §12 step 4 (supervision: exit and hang detection reaches the
parent) and D7 (no silent death) are agreed and not built. This builds them.
`comb health`, pure code, writes `~/.comb/health.json`:

| Finding | Rule |
|---|---|
| Stalled agent | No report, and no transcript or log activity for 12 hours, while its last state was working or blocked |
| Dead agent | Left the live list with no report (D7) |
| Waiting PR | Open more than 48 hours |
| Stale ticket | Open or in_progress, and a PR naming it merged more than 24 hours ago |
| Old card | Open more than 72 hours |
| Missed wakes | Gaps in the heartbeat |
| Nightly | Failed, or not run, from `readNightlyRun` |

The page shows "Stalled" as an agent state, in red. The findings go into
every wake packet and into Maya's morning message. hive-tk-163's 3.5 days
would have shown at hour 12.

### 5.3 Reminders that survive a restart

Maya's reminders are session crons and die with her session. Replace them
with `~/.comb/agents/<name>/reminders.json` (`at`, `message`), written by a
new comb-mcp tool `remind_me` and delivered by `comb wake` and the hourly
timer through the normal send path. A reminder is removed only after it is
delivered.

### 5.4 The always-on host

| Option | What it takes | What breaks |
|---|---|---|
| **A. The laptop, on AC at night** | Nothing new. Plug in | Travel days and unplugged nights are skipped. The heartbeat says so |
| **B. A home box (Mac mini)** | About $600, Greg's money. comb, hive and the repos installed there | hive's nightly reads Greg's session transcripts, which are on the laptop. State then has two homes: either Greg works on the box over ssh, or `~/.hive` and `~/.claude/projects` sync. hive's April distributed design was shelved (TK-066) |
| **C. Claude Code cloud scheduled tasks** | A subscription feature, in research preview | Documented: a cloud run gets a fresh clone and connectors only. It cannot reach `~/.comb`, `~/.hive` or local MCP servers. Everything comb is would need a second implementation |

**Recommend A now, and decide B on data.** After two weeks the heartbeat
gives the count of missed wakes. If more than a quarter of scheduled wakes
were missed, B is worth its cost and its sync problem, and that is a card
with the numbers. C fits a later mandate whose work lives entirely in a
GitHub repo, and it does not fit this one.

One known gap: Claude Code's docs say an idle background session is stopped
after about one hour; comb's notes record three (`daemon.log`, 2026-11-11).
Fresh sessions per wake make the holder indifferent to which is right. Task
agents are woken by message as today.

## 6. Opus and Fable together

### 6.1 The shape

Three seats differ in what they need.

| Seat | Needs | Tokens | Model |
|---|---|---|---|
| Holder | Notices, decides, acts instead of asking | Few: a packet read and some decisions per wake | Fable |
| Builder | Careful work over many turns | Most of the spend | Opus; Sonnet for mechanical jobs, as now |
| Verifier | Errors that do not match the builder's | Medium, bounded per PR | The model the builder did not use |

Greg's two observations both fit: Fable's initiative goes where decisions
are made, and Opus's cost advantage goes where the tokens are. comb's price
table has Fable at twice Opus per token (`src/pricing.ts`). Fable also has
its own weekly limit, which comb cannot read (design.md §9.1), so its seat
should be the small one.

**Maya stays on Opus for now.** Her misses this week were wrong claims and
forgotten follow-ups, and she did not lack initiative (she started TK-163 on
her own and withdrew her own card). More initiative at the seat with the
widest reach raises the cost of a wrong claim, and the forgotten follow-ups
are fixed by §5 for any model. Changing two seats at once would also leave
the experiment unable to say which change did what. If the Fable holder wins,
Maya on Fable is the next test.

### 6.2 The experiment

One mandate, one variable: `holder_model`. Builders and the verifier rule
stay fixed.

- **Crossover by week.** Weeks 1 and 3: Fable holds. Weeks 2 and 4: Opus
  holds. The holder starts fresh at each wake, so the switch is one field.
- **A paired check each wake.** The model that is not holding gets the same
  wake packet, read-only, and writes what it would do into `shadow/`. It acts
  on nothing. This is the shape of hive's shadow week (TK-166), which Greg
  approved. The paired record is the stronger evidence, because both models
  saw the same inputs. The weekly crossover alone is confounded by what was
  left in the backlog and by weeks like this holiday one.

| Measure | How it is counted | By |
|---|---|---|
| Landed and standing | Changes merged under the mandate, not reverted or corrected within 7 days | Code, from the ledger and git |
| Greg-minutes | Cards answered on the mandate, times 2 minutes, plus PRs he reviewed, times 10 | Code, as an estimate; Greg can correct it |
| Started without Greg | Task agents the holder started with no card | Code |
| Go rate | Greg's answers on the holder's cards. Baseline 63 of 90, and 33 of 36 in this area | Code |
| Wrong claims | Corrections logged against the holder's cards and reports | The holder logs them; Maya and Greg can add |
| Verifier catches | Verdicts of `fail` that the builder then fixed | Code |
| Cost | API-equivalent dollars for the tree, by seat | Code |
| Did nothing, rightly | Wakes that ended with no action. A count, with no target | Code |
| Paired disagreements | Wakes where the shadow plan differed, and which plan the following week favoured | Maya reads these; this one is judgment |

**Decision rule, set now.** With two weeks each, the numbers are small and no
test will be significant, so the rule looks for a gap anyone would call
large. Fable keeps the seat if it lands at least half again as many standing
changes as Opus with no more wrong claims. Opus takes the seat if the two are
within that margin, because it costs half. One wrong claim that causes a
revert of a landed change counts against a model as much as three landings
count for it.

## 7. The weekly report

Monday 08:00, `~/.comb/mandates/upkeep/reports/2026-W50.md`. The page shows
it under Reports, and one card asks for the renewal. The numbers come from
`comb mandate report --data` (code). The holder writes the sentences around
them and may not change a number.

Between reports the page has a "Landed without you" list read from the
ledger, so Greg can look at any time without being sent anything. One thing
is same-day: a change to how a system works gets one line to Greg (the
"Greg losing the map" danger in Maya's charter).

A mock. Every item in it is invented.

```
# upkeep, week 50 (Dec 7 – Dec 13)        holder: fable        status: active

Measure: 4 of 5 held.
  ✓ Nightly completed 7 of 7 nights with power. Mean $2.61.
  ✓ No agent stalled over 12 h.
  ✗ One ticket stayed open 31 h after its PR merged (hive TK-171).
    Closed Thursday. Cause: the wake on Wednesday 19:00 was skipped, on battery.
  ✓ The page answered at 19 of 19 wakes.
  ✓ No correction this week.

Landed without you (3)                                        revert
  comb #31  Timeline: lane labels no longer clip at 980px     git revert 4e1a9c2
  comb #33  Usage: Gemini token read handles an empty chat    git revert 9b07d1f
  hive #55  README: remove a command that does not exist      git revert c2f6a80
  Each: verifier pass (opus), gate pass. Verdicts are in the ledger.

Sent to you instead (2)
  hive #54  TK-163 nightly timeouts. Touches orchestrator.ts (protected).
            Verifier: pass. Waiting 2 days.
  comb #32  Health pass shows dead agents. Touches server.ts (protected).
            Verifier: cannot tell (could not make a session die on demand).

Did, and telling you (7)
  Started 4 task agents (hive TK-131, TK-160, TK-161; comb TK-015).
  Closed 5 tickets with merged PRs. Nudged hive-tk-131 after 13 h quiet.

Verifier caught (1)
  comb #33, first try: the fix dropped chats with one message. The builder
  fixed it. The second verdict passed.

Waiting on you (2 cards)
  Unload com.hive.watches (it exits 1 each hour).           3 days
  Renew this mandate to Dec 22?

Cost: $27.40 of $40.  Holder $4.10, builders $17.90, verifier $5.40.
Weekly limit when the week closed: 41%. The brake never came on.
Wakes: 19 of 21. Two skipped on battery (Wed 19:00, Sat 07:30).

Next week: TK-118 (templates), TK-129 (nightly watchdog, protected: a PR for you).

I'd change in the mandate: nothing yet. docs-only PRs are at 4 clean landings of 10.
```

## 8. Rollout

Each stage is small, can be undone, and has a test Greg can apply.

| Stage | What ships | Undo | Greg knows it worked when |
|---|---|---|---|
| **0. See** | `comb health`, the Stalled state on the page, durable reminders, the heartbeat. No autonomy | Remove the job; delete two files | A deliberately idle test agent shows Stalled at hour 12, and a reminder survives `comb start maya --fresh` |
| **1. Wake** | `com.comb.wake`, the mandate file and approval, the holder with tier 1 only. Status `shadow`: the verifier and gate run and record "would have landed"; Greg still merges everything | Pause on the page | After a weekend away, the report lists what the holder did, and it matches git and the tickets |
| **2. Land** | Per-agent settings file, `comb land` live, status `active` | Pause; or delete the settings file | Two weeks of shadow show no verifier `pass` on a PR that Greg then rejected or had to fix. Then the first landing appears in the ledger with a revert that works |
| **3. Install** | After a landing, the holder may build and install comb or hive: the old binary is kept, a health check runs, and a failed check rolls back | Remove the line from the mandate | An install happens at night and the page is on the new commit in the morning |
| **4. Second mandate** | An outcome mandate: collegevalue traffic (goal 500–1,000 visitors a week; the baseline is 20–40 engaged sessions) | Let it expire | Upkeep ran four weeks under budget, and the measure moved |

The Opus and Fable crossover runs across stages 1 and 2 (four weeks).

Upkeep is a proving ground with an exit. It makes Greg no money. A system
whose agents mostly maintain the agent system has failed by its own measure
(Beer: the purpose of a system is what it does). Stage 4 is the point of the
exercise, and upkeep's budget stays small so that it does not grow into the
main activity.

**Out of scope, and why.**

- **Hundreds of agents.** The limit is Greg's capacity to monitor, then one
  subscription's weekly limit. Neither grows with agent count. One to three
  mandates, each with a holder and a few task agents, is the size that fits
  one person.
- **Cross-person swarms.** comb's state is local files with one writer each,
  and trust here is one person's TRUST.md. Sharing needs identity, access
  control and a server. That is another product.
- **A rules engine.** The gate checks seven facts. Everything else stays
  judgment in charters (design.md principle 1).
- **Mandates for Greg's own sessions.** D9 holds.
- **Spending.** No mandate may spend money. A budget counts subscription use
  in API-equivalent dollars. It is not a purse.

## 9. Decisions for Greg

1. **Is hive and comb upkeep the first mandate?** (a) Yes, for four weeks,
   as a proving ground. (b) Start with collegevalue traffic. **Recommend
   (a).** Greg's Go rate there is 33 of 36, he uses the result daily and can
   judge it, and a failure harms no customer. Caveat: it is the least
   valuable area, so it gets a small budget and an end date.
2. **Does it include merge rights?** (a) Yes, from stage 2, through `comb
   land` only, after two weeks of shadow. (b) No merges; PRs only. (c) Yes,
   from day one. **Recommend (a).** Expect about one PR in five to qualify
   (§4.3).
3. **The protected list.** (a) As written in §3.2: nothing that starts,
   wakes or supervises agents, and nothing in the nightly pipeline. (b)
   Narrower, so more lands. **Recommend (a),** and shrink it by your edit
   as landings stay clean.
4. **How the merge permission is granted.** (a) A per-agent `--settings`
   file that allows only `comb land`, created by you. (b) A `gh pr merge`
   rule in `~/.claude/settings.json`, as approved on 11-24 and never added.
   **Recommend (a).** It needs one test in a scratch HOME first (§4.5). (b)
   gives every session on the machine the merge command with no gate.
5. **Fable where?** (a) The holder only; Maya stays on Opus. (b) Holder and
   Maya. (c) Opus everywhere. **Recommend (a),** then test Maya if Fable
   wins the seat.
6. **The experiment.** (a) Weekly crossover plus a read-only shadow plan from
   the other model at each wake. (b) Crossover only. (c) No experiment; pick
   one. **Recommend (a).** The shadow adds about one packet read per wake.
7. **The measure.** (a) Landed and still standing per Greg-minute, with
   started-without-Greg as a secondary count. (b) Started without Greg, as
   Maya proposed. **Recommend (a).**
8. **Host.** (a) The laptop on AC; decide on a home box after two weeks of
   heartbeat data. (b) Buy the box now. (c) Cloud scheduled tasks.
   **Recommend (a).** Your part: plug in at night.
9. **Wake times and budget.** (a) Three wakes a day, $40 a week, brake at 60%
   weekly and 50% session. (b) Hourly wakes. (c) Your numbers. **Recommend
   (a).** All Claude use this week was $226 API-equivalent with the weekly
   limit at 20%, so $40 leaves your own work untouched.
10. **The holder.** (a) A separate agent under Maya, fresh at each wake. (b)
    Maya holds the mandate herself. **Recommend (a).** It keeps Maya's
    context for Greg and makes the model a field.
11. **The report.** (a) Weekly, plus a ledger list on the page and a same-day
    line only when a system's behaviour changes. (b) Weekly plus a daily
    digest for the first two weeks. **Recommend (a).** A daily digest is the
    stream of cards again.
12. **Expiry.** (a) One week at a time, renewed by one card on the report.
    (b) No expiry; pause when needed. **Recommend (a)** for the first two
    months.
13. **Build order.** (a) Stage 0 first, on its own, now: it is design.md §12
    step 4, already agreed, and useful with no mandate at all. (b) Wait for
    the whole design. **Recommend (a).**

## 10. What I checked, and what I did not

- **Saw:** the precedent tallies and wait times (a script over
  `~/.comb/precedents/` and `~/.comb/queue/`); the nightly log's power lines
  for 11-22 to 11-28; the settings file's allow list and `autoMode` block;
  the PR lists and their files; the ticket lists; `launchctl list`; this
  week's usage and limit figures from the page's `/api/usage` and
  `rate-limits.json`.
- **Read:** design.md; the hive v2 spec on the `hive-v2` branch; Maya's
  charter, checklist, notes and log from 11-23; `src/pricing.ts`.
- **From a docs sub-agent, with URLs, not re-read by me:** the auto-mode
  order, `--settings` with `--bg`, hook output, cloud scheduled tasks, the
  one-hour idle stop.
- **Unverified:** that a `--settings` allow rule skips the classifier in a
  background session; that the `autoMode.environment` text is why merges are
  refused; `caffeinate -s` behaviour on battery (from hive memory, August);
  the gate backtest used file paths and line counts only, and I did not read
  the 28 diffs; the Greg-minutes weights (2 and 10) are guesses.
