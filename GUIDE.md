# Arena

A continuous multi-agent field for OpenCode: named agents work one goal at the
same time, negotiate in a shared room, and Vera the referee watches for stalls.
There are no rounds, no phases and no judge scoreboard. A claim closes a normal
field only when the verification agrees; in a same-role room it is a shared
solution, and the room stays live until every agent leaves or you terminate it.

No Docker. No container. Native child sessions, native room.

New to Arena? Read [ARCHITECTURE.md](ARCHITECTURE.md) for a plain-English tour
with a diagram, the cast and a full run walkthrough.

## What it does

- **The tab follows the work.** Starting a field opens the Arena tab; a manual
  close stays closed, and a new run opens it again.
- **A crew of perspectives, not task slices.** The main agent writes the crew on
  the fly: a real first name per agent, a perspective that fits this problem, and
  a personality brief. Names, perspectives and count are not fixed; if the user
  does not give N, the main agent chooses. Every seat can run the same OpenCode
  agent type (`build`, `uncensored`, `plan`, ...) with `agentType`, or one seat can
  override it. Vera is the referee: she watches for a stalled room and can pulse
  or report, but she does not assign work and does not abort a working field.
  **Any primary agent can start a field**;
  there is no dedicated arena agent to install or select.
- **One continuous conversation, no steps.** Every agent gets the Arena brief,
  the contract and the roster. It starts with the whole problem and stays in the
  room until it decides to leave. There is no per-agent step budget, no deadline
  by default, and no forced wrap-up. A named `@Name` mention is an answer
  obligation only for `request` and `question`; `@all` is attention, not a reply
  debt.
- **Same-role Arena.** `sameRole: "Builder"` gives every seat the same role and the
  whole problem, with no lane boundary. Each agent works independently, shares only
  useful facts/results/dead ends, and leaves on its own decision. The default
  workspace is copy-on-write: a shared read-only baseline plus one writable git
  worktree per agent. If the root is a home/drive root or cannot be isolated, a
  two-seat room runs in a **shared** tree and says so in the start message and in
  every seat prompt; a larger same-role room is refused before any session starts.
  Arena does not pretend the tree is private. Git is the version engine;
  if it is not installed, the plugin downloads the official MinGit build into its
  own tools folder. A non-git working directory is initialized in place with an
  `arena baseline` commit, so worktrees share the project's real history; a root
  that cannot be initialized falls back to a shadow repository. A solution is
  posted with its copy path so others can inspect or merge it.
  If you do not name a role or write a crew, Arena infers one: a single-target
  research, audit, fix or reverse-engineering brief becomes an independent same-role
  room (`Reverse Engineer`, `Security Researcher`, `Researcher`, `Auditor` or
  `Software Engineer`); a multi-deliverable or migration brief stays split. The
  inference is written into the plan and the start message, so you can override it.
- **One public room.** There are no private messages: every message is visible in
  the room. Facts and results are delivered to the matching lane and the verifier,
  not to every seat; everyone else sees them on the next state card. In a same-role
  room, facts, findings, results, dead ends, claims, answers and intents reach every
  seat; only pure commentary stays on the card.
- **No target gate.** A public host named in the brief is work to do. `start`
  accepts any host, URL or IP; `/arena` asks for nothing extra and network access is
  always on. Local files, loopback and remote hosts are the same.
- **Full records, one exit.** `take`, `release`, `fact`, `test`, `result`,
  `ask`, `leave`.
  A fact carries a claim, area and `evidence[]` (up to 64,000 characters); a test
  carries one command and one expected observation; a result carries
  `pass|fail|invalid`, raw output and the PID before/after. A `claim` may also carry
  `coverage[]`: what was proven and what was not. A coverage claim is an honest close
  for a partial result, not a false success. Structured records over the limit are
  rejected rather than silently cut; raw PII, credentials and command output belong
  in the record in full.
- **Safe-point delivery.** Orders from you or the Orchestrator steer at the
  agent's next safe point. Peer messages are also injected at the next safe point
  while the agent is working, batched through the per-agent FIFO inbox, so a long
  tool run does not make an agent deaf. When the agent is idle, the same inbox is
  flushed as one batch. The inbox is capped at 24.
- **The claim gate.** A claim must pass the declared verification command, must
  not be falsified by one idle peer, and must carry evidence. Two rejections
  close the claim. The field keeps going until a claim is accepted, every agent
  has chosen to leave, or **you** stop it. Vera may recommend a close; she cannot
  force one. An agent that leaves is permanently sealed: no User, peer or
  coordinator message can wake it again.
- **One chat, commands in the text.** The text is the message; `stop`,
  `stop Ada`, `leave Ada`, `continue` and `goal: …` are commands. `stop` and
  `leave` are User-only; the coordinator cannot force an agent out. Every routed
  message is also written into the agent's own transcript as an `[arena.room]`
  note.
- **Legacy-free.** Rounds, native delegation, `compete`/`team`/`evolve` and the
  judge score table are gone. Git is the version engine; MinGit is bootstrapped
  automatically when it is missing. One mode remains.

## Install

Requirements: OpenCode 2.2 or newer, Bun 1.2 or newer, and a desktop build of
OpenCode for the Arena tab. Git is used for worktrees and merges; on Windows the
plugin downloads official MinGit automatically if git is not already installed.
No MCP server, no Python, no Docker and no agent file is required.

The setup script installs a self-contained copy into OpenCode, builds the tab
there, and copies the skill:

```powershell
# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

```sh
# Linux / macOS
bash scripts/setup.sh
```

Either way, add the plugin to the whole-workstation config once, in
`~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/arena"]
}
```

The setup script installs a real copy at `plugins/arena`; the source clone
is not used at runtime, so the Desktop folder can move or be deleted. To update,
`git pull` in the source and run the setup script again.

If you prefer an absolute path, point `plugins` at the installed copy, for example
`["C:/Users/<you>/.config/opencode/plugins/arena"]` or
`["/home/<you>/.config/opencode/plugins/arena"]`. On OpenCode builds that
include the plugin command, `opencode plugin add "/path/to/arena"`
installs the source clone instead, which is fine for development.

For one project only, use the absolute path to the installed copy in that
project's `opencode.json`; a relative `./plugins/...` entry is resolved from the
global config, not from the project folder.

The plugin registers `arena`, `arena_bus`, `arena_fs`, `arena_git`, `arena_exec`,
`arena_job` and `arena_spawn` for every agent that may use tools. **No agent file is required.** Any primary agent (`build`, `plan`,
`uncensored`, ...) can call `arena` with `action: "start"`; there is no
`arena-orchestrator` to select.

The setup script already copies the skill so the natural-language trigger is
discoverable. To refresh it manually:

```powershell
# Windows PowerShell
Copy-Item skills/arena "$HOME/.config/opencode/skills/" -Recurse -Force
```

```sh
# Linux / macOS
cp -R skills/arena "$HOME/.config/opencode/skills/"
```

Restart OpenCode. The tools appear for agents that may use tools. The Arena tab
appears in the desktop side panel after the app reloads the plugin.

The source builds a self-contained copy: `src/`, `skills/arena`, `package.json`,
`bun.lock`, and `bun run build:gui` for `dist/gui-experimental.cjs`. The setup
script copies those runtime files into OpenCode and installs/builds them there.
There is no separate agent package or service to install, and no MCP server or
container is required.

## Ask for an arena in plain language

```text
make an arena of 4 agents that find why duplicate webhook events create two orders
```

The agent you are talking to calls `arena` with `action: "start"`, the objective,
an optional `crew` and an optional `verification` command. The plugin starts the
named agents and Vera as child sessions, posts the Arena brief to each, and keeps
your session free. Follow it with `arena action status`, the Arena tab, or chat.

A small field with a verifier:

```jsonc
{
  "action": "start",
  "objective": "Prove the boundary case of the recurrence and add the regression test",
  "crew": [
    { "name": "Mira", "role": "Minimal-fix builder", "brief": "ships the smallest change and proves it" },
    { "name": "Omar", "role": "Concurrency skeptic", "brief": "attacks ordering, retries and partial failure" },
    { "name": "Ines", "role": "Domain mapper", "brief": "maps the call path before anyone edits" }
  ],
  "verification": "bun test",
  "agentType": "uncensored",
  "mentionTimeoutSeconds": 60,
  "leaseMinutes": 10
}
```

## The Arena tab

The tab is a native `Panel` in the desktop side panel, with a pinned `Arena` tab
and a `+` menu launcher. It shows:

- the field header: status, posts, dead ends, claims, open asks, elapsed/budget,
  and each named agent with its status and any wait,
- user messages on the right, agent messages on the left, system rows centered,
- one compact composer row: a `+` attach button on the left, the text box in the
  middle at the same height as the buttons, and an `↑` send button on the right.
  Paste (Ctrl+V), drag and drop, or pick files. Up to 4 files, 8 MB each; images
  are downscaled to 1600 px before sending. Every message is public to the whole
  room. There is no mention selector: type `@Name` in the message to focus that
  agent, or `@all` for attention to everyone.
- a red `φ` button at the top-right of the header terminates the Arena for
  everyone. It is the only termination control; the coordinator cannot stop it.
- attachments render as thumbnails (images) or file chips in the transcript, and
  are passed to every agent as real prompt files, not links. Message text is
  selectable and copyable like the normal session chat. Click any image thumbnail
  to open it in a full-panel preview; click the backdrop, press Escape, or use the
  close button to return.
- `@Ada` in the text mentions Ada; `stop`, `stop Ada`, `leave Ada`, `continue`
  and `goal: …` are commands. `stop`/`leave` are User-only; the coordinator
  cannot force an agent out,
- a "… is typing" line while an agent is working on a request,
- Enter sends, Shift+Enter adds a line,
- a close button on the Arena tab; reopen it from the + menu.

The panel talks to the server through a typed RPC and an Ipc bridge, push-driven
from the server's event stream with a long-poll fallback. If the desktop app does
not load the experimental GUI bundle, the field still works through the tools.

## The `/arena` command

Type `/arena` followed by the problem:

```text
/arena Fix the duplicate webhook order bug without changing the public API
```

The command is registered by the plugin itself. It works in a fresh session and in
a session that already has chat history; it resolves the session to its root before
creating the field. It does not ask the main agent to plan, ask a clarifying
question, or write a preamble. It strips `/arena`, analyzes the brief, chooses a
small crew (3 by default, 4 for a multi-lane investigation), and starts the same
field the `arena` tool starts. A one-file fix gets two agents.

The `/arena` command and its full brief are written to the **main agent chat** as a
real user row before any worktree or session is created. The Arena room is used
for the field, not for duplicating the command. A refused or incomplete start also
appears in the main chat, so a failed command is never a silent no-op.

To continue the same live agents, sessions, workspace and history with a new
mission:

```text
/arena continue Add the regression test and re-run the suite
/arena continue --minutes 30 Re-check the boundary after the fix
```

There is no record to supply. `/arena` starts on any live host named in the brief,
and the flags are only `--same-role`, `--role`, `--agents` and `--minutes`.

A live field keeps every agent and its context. If the previous field has already
closed, the same crew labels, roles and history are restarted because sealed
sessions cannot be reopened; the old run id is not reused.

An explicit count overrides the estimate, and there is no low ceiling:

```text
/arena --agents 50 Run 50 attackers in parallel against the login boundary
/arena --agents 50 --minutes 45 ...
/arena --same-role "Builder" --agents 4 Make Adobe Acrobat 25.1 permanently Pro
```

If you omit `--same-role`, Arena infers the best form: a single-target research,
audit, fix or reverse-engineering brief becomes a same-role room automatically
(typically `Reverse Engineer`, `Security Researcher`, `Researcher`, `Auditor` or
`Software Engineer`). Multi-deliverable and migration briefs stay split. The start
message names the inferred role, so you can override it next time.

The default is 100 concurrent seats; set `ARENA_MAX_AGENTS` to raise it (up to 500).
The analyzer also reads an explicit count in the brief ("run 50 attackers"). Use 50+
for independent attack surfaces, not for a single-resource task: one Acrobat install
still has one launch slot.

The analyzer also chooses the coordination mode and an oracle:

- **split** for independent lanes that must not touch the same area. An installed
  or mutable target (machine, process, registry, binary, port) is forced to split,
  and attack lanes must serialize writes and launches through a lease.
- **race** for several independent attempts at the same target, where duplicate
  work is expected; not used for one installed resource.
- **hybrid** when some lanes race and others split.
- **independent** for a same-role room: every seat owns the whole problem, there
  are no lanes, and duplicate attempts are expected. In copy-on-write each tree is
  private, so only a host launch needs a lease; in a shared tree the write and the
  launch both take one.
- **sameRole** selects the independent mode; every seat gets the same role and the
  whole problem. A solved copy is shared in the room; the field stays live until
  every agent leaves or you terminate it. If the root cannot isolate, the room is
  explicitly shared.
- **toolPolicy** defaults to `all` and exposes host, MCP, browser and subagent
  tools in addition to Arena. Set `"arena"` for the strict allowlist; `/arena` uses
  the default.
- the **oracle** is the one observation that decides the task, plus the baseline
  command. The field will not start an experiment until recon confirms it.

The Arena tab shows the crew, the mode, the lanes, the oracle, the running
experiment and the facts. An empty command prints the usage line. If the session
already has an active field, `/arena` reports its run id and `/arena continue`
reuses it; stop the field before starting a new crew.

## Tools

### `arena`

| Action | What it does |
|---|---|
| `plan` | show crew size, continuous mode, referee, models, network and the reason, without starting |
| `start` | start the field: named child sessions plus Vera |
| `continue` | keep the live agents, sessions, workspace and history; `message` is the new mission |
| `status` / `report` | board and recent room; `report` includes the recent transcript |
| `chat` / `steer` | speak in the room; `steer` marks the message as an order |
| `read` / `consume` | read the room; keep or drop ids from one agent's digest |
| `finish` | post a claim as a bound agent (the gate checks it) |
| `update` | switch an agent/model or send a task to one named agent |
| `list` | list active fields |

### `arena_bus`

The work verbs:

| Verb | What it does |
|---|---|
| `take` | claim an area with a `read`, `write`, or `launch` lease |
| `release` | free every lease the caller holds, or hand an experiment to a new owner |
| `fact` | one claim, `area`, `evidence[]`; duplicates return the existing id |
| `test` | one hypothesis, one `command`, one `expect`, optional `killIf`/`preflight` |
| `result` | `pass`, `fail`, or `invalid`, plus `observed`, `pidBefore`, `pidAfter` |
| `ask` | one named peer, one question, one deadline |
| `leave` | end your own participation permanently; no one can wake you again |

`oracle` posts the confirmed pass/fail observation and its baseline. It must
include `baselineAt`, `scope` and `writer`; a baseline from before this field or
a global/shared log is rejected. An owner can run one active experiment; different
owners may test different resources in parallel, and two tests that name the same
area serialize. A reused PID makes the result `invalid`, not a pass. A handoff may
include `experiment=e1` and `to=Name` to transfer a running experiment. `dead-end`
and `claim` still exist for a closed route and a final result. `read` returns the
oracle, experiments, truth table and room; `read id=mN` returns one full message.

A named mention is an answer obligation only for `request` and `question`. Reply
with `kind=answer` and `replyTo=<message id>`. `@all` is attention for everyone and
creates no reply debt. Acknowledgments are stored but never delivered.

### `arena_fs` / `arena_git` / `arena_exec` / `arena_job`

These tools replace host shell and file mutation for field agents. They are
registered as direct tools so a seat can call them by name. The default
`toolPolicy: "all"` also exposes host `shell`/`write`/`edit`, MCP servers, browser,
skill, task/subagent and UI tools; the Arena tools remain preferred when you want
the run lock, branch, lease and audit trail. MCP tools appear only when your
OpenCode profile has MCP servers configured; Arena no longer blocks them. `toolPolicy: "arena"` keeps the strict
allowlist: arena tools plus read/grep/glob, webfetch/websearch (when network is
enabled), skill, `question` and `arena_spawn`. A spawned helper inherits the
caller's policy: under `arena` it is read/search-only; under `all` it is a normal
subagent. If a host exposes only Code Mode, an `execute` body that calls only
Arena tools is allowed in either profile.

| Tool | What it does |
|---|---|
| `arena_fs` | `read`, `list`, `stat`, `status`, `diff`, `merge`, `write`, `copy`, `remove`; in a shared tree writes/merge take the run lock, in copy-on-write they stay in the agent's own tree |
| `arena_git` | `status`, `diff`, `log`, `commit`, `merge --from`, `abort`, `resolve --take`; branch-level git for copy-on-write seats. Merge stops before the commit, reports conflicts, and runs the field verification before accepting. |
| `arena_exec` | run a command/launch in the agent's workspace; shared tree takes the run lock unless `resource=` names the one file/service it touches, copy-on-write only serializes a host launch; foreground default 60 s, max 120 s, then the process **tree** is killed |
| `arena_job` | `list`, `status`, `output`, `stop` a tracked background job |

Background jobs are allowed only in copy-on-write mode, so they cannot mutate the
shared baseline. In copy-on-write, static commands run in parallel because each
seat owns its tree; only a launch lease serializes a host process. A shared tree
uses the global lock by default; `resource=` narrows it to one file/service, so
two different resources can run in parallel. A foreground command that leaves a child alive is killed
with `taskkill /T /F` on Windows; killing only the shell leaves the child holding
the lock and the whole field waits forever. A watchdog also detects a member whose
foreground job outlives the stall window, kills it, releases the lock, marks the
seat idle, and posts a verdict so the room resumes automatically. The version engine is git, not an external merge tool. If git is
missing on Windows, the plugin downloads MinGit once into its own tools directory;
a fresh machine does not need a package manager.

`webfetch` and `websearch` are allowed when the field has network enabled; a field
started with `network:false` rejects both. There is no scope check: any URL the
brief names, or the agent discovers, is fetched.
If the working directory is not a git repository, Arena runs `git init` there,
sets byte-preserving checkout config locally, and commits an `arena baseline`
before the first worktree. `node_modules`, `dist`, `build`, `.next`, `.cache` and
Arena's own directories are excluded through `.git/info/exclude`, not a tracked
`.gitignore`. Both the real repository and the fallback disable `core.autocrlf`
and text conversion, so each copy starts byte-identical to the target; otherwise a
Windows global `autocrlf=true` rewrites line endings and every hash differs before
the agent has changed anything. A root that cannot be initialized falls back to a
shadow repository in temp, which is cleaned up with the field; a shadow is bounded
to 5,000 files and 512 MB, and a larger root fails with an actionable message.
Home and drive roots are never initialized and stay shared.

### `arena_spawn`

Launch one bounded native subagent (any visible agent id) from an agent's turn.
Depth is capped at three. Use it for a narrow side question, not for the main
work. A helper started by a field seat is read/research-only: its permission rules
deny shell, write, edit, task, nested subagent and browser actions.

## Productivity rules

The defaults are continuous: **no per-agent step budget, no deadline, a referee
check every 2 minutes, no global experiment quota**. Only the User can set
`maxDurationMinutes` or stop the field. More agents do not make a field faster;
they multiply duplicated analysis. A serialized installed target (one binary, process, GUI or launch slot)
defaults to **2 seats**; an explicit `--agents N` still overrides it. Use 50+ only
when the brief has 50+ independent attack surfaces.

Every prompt starts with the same 18-line state card: goal, oracle, two observed
facts, two refuted routes, your lane, the running experiments and one next action.
A `HEALTH` line names the oldest running foreground job and its age. The board and
`arena status` also report the delivery ledger: delivered/queued, p50 and p90
post-to-seat latency, and how many structured posts were truncated in the inbox.
In a same-role room a seat gets the full card once, then a compact delta on later
wakes; resume and compression send the full card again. The coordinator gets the
same card and a short room digest, not the full room. In an independent room only facts, results,
dead-ends, claims and direct asks are broadcast to every seat; intents, answers and
routine verdicts stay on the room/card instead of waking everyone.

Every agent is told the same working agreement:

- start in your assigned lane; in **race** mode duplicate attempts are expected,
  in **split** mode do not roam without a handoff;
- answer the User and `request`/`question` mentions before continuing your own work;
- post a `fact` only when it changes the state card;
- in a shared tree, `take` with `leaseKind` and paths before a write or launch; in
  copy-on-write your tree is private, so write directly and lease only a host
  process you launch. A launch lease records the job id and PID, and the driver
  releases it only after that process tree is gone. A conflicting launch lease is
  refused, and `release` frees every lease you hold;
- use `arena_fs` for files and `arena_exec` for commands; host shell/write/edit are
  blocked. Run probes expected to exceed 20 seconds with `arena_exec background=true`
  and post the job id, then inspect/stop it with `arena_job`;
- never go quiet after learning something: post a fact, a result, a dead-end or a
  claim; if you learned nothing, just wait;
- a lesson only after the experiment result; a claim ends your work; you leave
  with `arena_bus action=leave` when you decide the lane is done.

The session that starts the field is the **coordinator**. It receives the state card
plus a coalesced digest of facts, findings, results and blockers (default every 90
seconds), can read the board, and can speak to the crew with `arena chat` or
`arena steer`. In a same-role/independent room it cannot issue an order; it can
still publish a plain chat, which is a broadcast, not a command. It is not a worker:
while the field is live, shell, read, edit, browser and subagent tools are rejected
for that session. The UI-only `deck_progress` plan band and `question` are
exceptions; they cannot do project work. Sixteen **orders** per field, one per 30
seconds, 600 characters, one owner; a plain chat does not spend that budget, so a
coordinator that runs out of orders can still report. An over-budget or broadcast
order is rejected privately and never enters the room. It answers you, guides the
room, and cannot force an agent out. It does not need to poll: the next update wakes
it.

There is no dormant state and no “another round”. An agent is either in the room or
gone. An agent leaves by its own decision (`arena_bus action=leave`) or because the
User forced it. A left agent is **permanently sealed**: User messages, peer
messages, coordinator traffic, resume turns and injected notices are all rejected.
The seal is rebuilt from stored field state after a process restart, and `unseal`
refuses a `left` seal. Only a fresh field/session can bring that work back.

## How it decides

```
contract ──► Vera the referee ◄── board every 2m / when quiet / after 10 posts
   │              │
   ▼              ▼
 Ada  Hypatia  Turing  Curie  Zaha  Raman
   └──────┬───────┴───────┬──────┘
          ▼               ▼
     shared bus      per-agent inbox (safe points)
          │
          └──► claim ──► gate: verification + peer falsifier + evidence
```

Vera is a standing referee, not a four-shot reviewer. Her **role and contract are
injected once** into the Vera session; each check sends only the current board, not
the same role/objective block again. She is not asked while every active seat is
working; the deterministic lag watchdog covers that case, and she is asked when the
room is stalled, idle, or a decision is needed. One close recommendation is kept for
five minutes instead of being repeated every interval. The referee answers JSON
only: `continue`, `pulse`, `report`, `abort`. A pulse asks who has a new fact or a
route to close; it does not assign one and it does not wake idle agents. `report`
and `abort` are **recommendations**: they post a verdict and the field stays live.
Vera cannot force a close; only the User can stop the field, and each agent decides
whether to leave. A close is never done by hand, because every claim starts the
gate automatically. After 20 minutes with no new evidence, each seat gets one
`[arena.converge]` prompt to post a final result, a dead-end, or leave.

## Mentions are asks

A named `@Name` mention creates a reply request only on `request` or `question`. The
default window is 60 seconds; set `mentionTimeoutSeconds` on the field or
`replyInSeconds` on one message. The mentioned agent is woken if idle and receives
the ask at its next safe point if it is working. The reply clock starts when the ask
actually reaches the target, so a busy agent does not lose it unseen. The asker
holds its reply debt until the answer arrives or the window expires. When the
window expires, the asker is told to continue without it, and no room notice is
posted. `@all` reaches everyone but creates no reply debt. `@Orchestrator` from you
still reaches the main session. An `answer` or `finding` mention is attention, not
debt.

## Self-coordination

Each agent starts with a lane, not the whole goal. In **split** mode the lane is an
ownership boundary; in **race** mode several lanes attack the same target and
duplicate work is expected. The state card names the running experiments; each
owner may have one active test, and two tests that name the same resource serialize.
Before editing a file, writing a resource or launching a target process, an agent
posts `take` with a `leaseKind`, the paths and a short lease. A second write or
launch on the same resource is blocked before it happens. `release` frees every lease the agent holds, with no area string needed. A
`lesson` is one reusable line, and only after the experiment result.

A `fact` is structured evidence, not commentary. The board keeps a truth table;
the same claim from a second agent returns the existing id instead of a duplicate.
Two conflicting facts become one arbitration with a single decisive test, assigned
to a neutral agent. A `result` closes the experiment and records `pass`, `fail` or
`invalid`; a reused PID is invalid.

Prior memory is loaded for the same objective, or for a follow-up field in the
same session when the wording changed: earlier facts are seeded as `assumed`, and
the kickoff says "do not re-derive, test the delta".

## The gate, precisely

1. If the contract declares `verificationCommand`, run it on the shared
   workspace and record the real output.
2. Ask one idle peer to falsify the claim with one cheap check.
3. Accept only when the verification passed (or no command was declared), the
   peer did not falsify it, and the claim carries evidence.

An accepted claim posts a `verdict` message, marks the room goal accepted and
stops every agent. A rejected claim returns the claimer to work with the reason.
The field never fakes success.

## Persistence and reload

| Key | Value |
|---|---|
| `arena:field/<runID>` | field state |
| `arena:field/meta/<runID>` | contract and plan |
| `arena:field/latest/<sessionID>` | latest run for a session |
| `arena:field/sessions/<runID>` | label → session id |
| `arena:field/bind/<sessionID>` | session → run label |
| `arena/room:<sessionID>` | room snapshot |

On reload the service repairs missing sessions, posts "resumed after a reload",
and restarts the loop with a `Resume:` message. Unreadable state is marked
`interrupted` and stays readable.

There is **one driver per project root**, not one per seat worktree. A field seat
runs in its own worktree, and OpenCode loads plugins per session location; using
that location as the service key created four drivers for a three-seat field. They
all resumed the same field, ticked at the same time, posted duplicate notices and
wrote conflicting state. The service is now keyed by the project directory, so the
parent and every seat share one driver.

## Failure behaviour worth knowing

- **Agent mid-command when a message arrives**: it waits; the batch is injected at
  its next safe point.
- **Agent silent**: no automatic nudge. It stays in the room and is woken by the
  next peer or User message. A quiet field gets one convergence prompt, then goes
  model-quiet; it stays live because only the User can stop it.
- **Field idle forever**: the User must press the red `φ` or send `stop`. The Arena
  will not close itself. That is deliberate: only the User owns termination.
- **Agent leaves**: its session is sealed permanently; no message or wake path
  exists.
- **Mention unanswered**: the asker continues after the reply window expires.
- **Session gone**: recreated from the stored label/agent and notebook, unless the
  member had left.
- **Referee answers prose**: one repair prompt, then `continue`.
- **Verification throws**: treated as FAIL.
- **Stop**: the User stops the field; every session is interrupted, a STOP order is
  posted, the room closes. The coordinator and Vera cannot do this.

## Layout

```
src/core/        field state, inbox, claim gate, knowledge   host-free
src/field/       roster, prompts, the FieldRun driver        host-neutral via FieldDeps
src/plugin.ts    OpenCode wiring: tools, hooks, RPC, cache
src/service.ts   rooms, sessions, storage, names, resume, hooks
src/host/        HostPort + the OpenCode adapter
src/gui.tsx      the Arena tab (Solid)
docs/            field-design.md, architecture.md, porting.md
```

`src/core/**` imports no `@opencode/*`, reads no globals and receives `now`.
`src/field/run.ts` talks to the host only through `FieldDeps`. Porting means one
adapter file plus the plugin entry (see `docs/porting.md`).

## Development

```sh
bun test              # field, room, service, plugin, host
bun x tsc --noEmit    # types
bun run build:gui     # dist/gui-experimental.cjs
```

The design is in `docs/field-design.md` and `docs/architecture.md`. A plain-English
tour with a diagram, the cast and a full run walkthrough is in `ARCHITECTURE.md`.
