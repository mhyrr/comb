# Decision: comb with hive, or on its own

**For:** Greg. **Status:** open; Greg decides. **Written:** 2026-11-14.

## The question

Before comb goes public: should it fold into hive, stand on its own over
Claude Code with hive as an option, or stay as it is?

## Recommendation

**(b) Standalone over Claude Code, with hive as an optional adapter.** A
stranger with only Claude Code cannot start a single agent today, because
every start runs `hive identity emit` and fails without it. That dependency
gives comb identity and nothing else it needs to work. Making identity
optional and moving `attach` into comb is about a day or two of work. Your
own setup keeps working the same way, because hive becomes the adapter you
always have on.

**The caveat:** Maya's persona and voice come from hive's identity. Without
hive, comb must ship a default chief-of-staff identity file, and that file is
a second voice to keep in step with hive's. Expect the stranger's Maya to be
plainer than yours.

## How comb touches hive today

| Coupling | Where | Without hive |
|---|---|---|
| Identity: `hive identity emit` at every start and wake | `src/agents.ts:261`, `src/hive.ts` | **Start fails.** Nothing works |
| Preamble names hive: "the hive's shared voice", `write_hive_memory`, `TRUST.md`, council | `agentPreamble`, `src/agents.ts:101` | Agents get instructions for tools they do not have |
| Agents' memory and tickets: the `hive` MCP server from the user's global Claude config | Implicit; Maya's charter, the preamble | Agents keep notes in their workspace only |
| Project of a directory: `~/.hive/projects/*/config.md` | `projectForDir`, `src/hive.ts` | `project: null`. Already works |
| Maya's charter: a project's cwd comes from hive's registry | `templates/maya-charter.md` | Maya has to be told the path |
| Page Tickets, Memory, Priority tickets, Start on a ticket: a read-only hive MCP client, its command read from `~/.claude.json` | `HiveClient`, `src/page/server.ts:200` | Those views show an error |
| Nightly picks and briefing asks into the queue (D23) | `src/nightly.ts` | Already a no-op: missing files read as none |
| `hive attach <name>` on the page chip and in Open in terminal | `src/terminal.ts`, `src/page/ui/app.ts:937` | Falls back to `claude attach <name>`, which can match the wrong session |
| `hive attach` itself lives in hive and reads `~/.comb` | `hive/src/commands/attach.ts` | n/a. **This breaks D10's rule**: hive now knows comb exists |
| "Greg" and "Maya" in text: the message signature agents read, the preamble, the skill and charter text. (**Done:** the page's name for the human comes from `userName` in `~/.comb/config.json`, default "You". The internal id stays `greg`.) | `src/transcript.ts:24`, `agentPreamble`, `skills/`, `templates/` | Agents read "Greg, on the comb page:" and Greg's name in their instructions |

Couplings that are not hive but matter for strangers: macOS only (launchd
for the page, Terminal.app or Rex for Open in terminal), Bun to build, and
Claude Code 2.1.319 or later for `--bg` and `claude agents --json`.

## The three shapes

### (a) comb as a module inside hive

- **A stranger gets:** one install (`hive`'s `install.sh`), and all of hive
  with it: identity, memory, nightly launchd jobs, watches, the Maya persona.
  They take the whole system or nothing.
- **Cost to build:** high. Move the repo in, reverse D10, merge `~/.comb`
  into `~/.hive` or keep two homes in one tool, and rework the tests' rule
  that they never read the real `~/.hive`. About a week, and churn in both.
- **Greg loses:** the line between "who you are" and "who is working on
  what" (§1's table). hive grows a process supervisor, a web server and a
  queue. Each tool's design doc stops being small.

### (b) comb standalone over Claude Code, hive optional

- **A stranger gets:** clone, build, `comb init`, and a working tree of
  background agents with the page and the queue. Identity is a plain file
  they can edit (`~/.comb/identity.md`, seeded from a template). With hive
  installed, they also get project memory, tickets on the page, and nightly
  picks in the queue.
- **Cost to build:** small, about 1–2 days with tests:
  1. An identity source: hive when `hive` is on PATH, else
     `~/.comb/identity.md`, else a shipped default. Starts never fail for
     want of hive.
  2. The preamble's hive lines (memory, tickets, TRUST.md, council) appear
     only when the hive source is active.
  3. The page hides Tickets and Memory when no hive MCP server is
     configured. Nightly is already safe.
  4. `comb attach <name>` in comb, a move of `hive/src/commands/attach.ts`.
     hive's command can stay as an alias that calls comb, or go. This
     restores D10.
  5. The user's name and the chief of staff's name from comb's own config
     (default "you" and "maya"), not `GREG` and literals. **Partly done
     (2026-11-14):** the page reads `userName` from `~/.comb/config.json`
     (`src/config.ts`) and defaults to "You". The id `greg` stays, so stored
     state needs no migration. Left: the chief of staff's name, the
     signature on page messages, and the name in the preamble, skill and
     Maya's charter.
- **Greg loses:** almost nothing at runtime; his setup is the hive adapter
  on. He pays a second code path (with and without hive) in tests, and one
  more file to tune (the default identity).

### (c) as it is

- **A stranger gets:** a README that says "install hive first". Then the
  full system, but with Greg's name in agents' instructions and hive's Maya
  persona.
  Without hive, nothing.
- **Cost to build:** none.
- **Greg loses:** most of the audience. Few people will install two
  opinionated tools to try one. `hive attach` keeps the boundary broken.

## What decides it

D10 already chose a separate tool that reads hive one way. (b) is D10
carried through: the one-way rule becomes "comb works without hive and is
better with it". (a) reverses D10. (c) keeps D10 on paper while comb cannot
run without hive and hive reaches into comb.

hive is public on GitHub but has no LICENSE file, so it is not yet open
source. If comb depends on it, hive needs one too.

## If Greg says go on (b)

Build it as five layered commits in the order above, each green, on its own
branch. Then the README's "Requirements" section loses the hive line, and
the hive section becomes "Optional: hive".
