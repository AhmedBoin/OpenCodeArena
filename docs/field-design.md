# Arena field — design

**Status:** approved direction (continuous peers, one goal, one bus)
**Supersedes:** rounds, native delegation, and the compete/team/evolve modes.

## 1. Intent

One goal. N peers. One live bus. No rounds, no phases, no scoreboard.

Each agent works on the goal in its own session, with its own persona and its own
memory. When it learns something useful it posts a small message to the group.
When it hits a wall it posts a dead end so nobody repeats it. Peers read the group
only at safe points, never inside a tool call. The **referee** watches for a
stalled room and can pulse or report. A claim only closes the field when
verification agrees. A working field is never aborted because it is quiet.

The model is a research group or a red team, not a debate club.

## 2. Roles

| Role | Who | Job |
| --- | --- | --- |
| **User** | you | Highest privilege: chat, steer, stop, override. |
| **Orchestrator** | the main session (any primary agent; no special agent required) | Turns a request into a contract, designs the crew, starts the field, receives user room messages plus batched peer updates, and guides the crew with `arena chat` or `steer`. It cannot stop the field or force an agent out; those are User-only. While the field is live, its shell/read/edit/browser/subagent tools are rejected; it is a coordinator, not a worker. |
| **Referee** | Vera, a dedicated child session | Reads the compact board and keeps checking (no cap by default), deciding continue / pulse / report / abort. She does not assign work, wake idle agents, or close claims. `report` and `abort` are advisory; she cannot force a close. |
| **Agents** | the crew the main session designs | Work the goal from their own perspective, post small facts, negotiate area leases, claim done only with evidence. |

The crew is created per run by the main agent: a unique real first name, a
perspective that fits the task, and a personality brief. There is no fixed roster.
If the main agent omits the crew, the plugin generates one from a name pool and
six archetypes, so a run never starts empty. `/arena` analyzes the brief, chooses
**3 agents by default** (4 for a multi-lane investigation), and assigns lanes before
any session exists. An explicit count is not clamped low: `--agents 50` or "run 50
attackers" starts 50 seats. Use 50+ only when there are 50+ independent attack
surfaces; one target with one launch slot stays a small crew.

A **same-role** room is the independent form: every seat gets the same role and the
whole problem, with no lane. The default workspace is copy-on-write (one shared
read-only baseline, one writable copy per agent); a solved copy is posted with its
path. If the root is a home/drive root or cannot be isolated, a two-seat room
starts in a **shared** tree and says so in the start message and the seat prompt;
it does not tell agents their tree is private when it is not. A same-role room
above two seats is refused before any session is created. An accepted solution is shared,
not a field close; each agent leaves on its own, and only the User terminates the room.

A public host named in the brief is work to do. Nothing gates it: `start` accepts
any host, URL or IP, `/arena` asks for nothing extra, and network access is always
on. There is no record field to supply and no scope check at fetch time.

If the brief does not name a role or write a crew, the planner infers one. A
single-target research, audit, fix or reverse-engineering brief is independent and
same-role; multi-deliverable and migration briefs stay split. The inference is
recorded in the plan and start message so the user can override it.

Every agent is told who else is in the Arena, what they are good at, its lane, and
that Vera is the referee. Every prompt starts with the **state card**: goal, oracle,
observed/refuted truth, lane, the running experiments and the next action. A
named mention is an answer obligation only for `request` and `question`; `@all` is
attention. `split` lanes are ownership boundaries; `race` lanes may duplicate the
same attempt on purpose; `independent` (same-role) rooms have no lanes at all and
every seat owns the whole problem. In copy-on-write the write target is private, so
only a host launch needs a lease; in a shared tree a write or launch needs one. This
removes the meaningless "who owns UltraISO.exe" fight between seats that each have
their own worktree.

## 3. The loop

```
kickoff ─► work ─► post ─► (peers read at safe points) ─► claim ─► gate
   ^         │                                              │
   └── pulse ┘                              rejected ───────┘
```

There is no phase machine, round counter or step budget. A normal split/race run
ends when the gate accepts a claim, every agent has left, or **you** stop it. In a
same-role room an accepted solution is shared, not a close; it ends only when every
agent leaves or you terminate it. A referee report or abort is a recommendation,
not a close. When the field ends, the driver assembles a `FieldReport`: proven
facts, unproven hypotheses, artifacts and remaining routes.

## 4. The bus

`arena_bus` has the work verbs plus `leave`. The board is the source of truth; the
bus only changes it, and the state card shows the result.

| Verb | Meaning | Max visible text |
| --- | --- | --- |
| `take` | Claim an area with a `read`, `write` or `launch` lease | 400 chars |
| `release` | Free every lease the caller holds, or hand an experiment to a new owner | 400 chars |
| `fact` | One claim with `area`, `evidence[]`; duplicate claims return the existing id | 1,200 chars |
| `finding` | A shared observation; same-role rooms broadcast it | 1,200 chars |
| `test` | One hypothesis, one `command`, one `expect`, optional `killIf`/`preflight` | 1,200 chars |
| `result` | `pass`, `fail` or `invalid`, plus `observed`, `pidBefore`, `pidAfter` | 1,200 chars |
| `ask` | One named peer, one question, one deadline | 600 chars |
| `leave` | End your own participation permanently; no one can wake you again | 360 chars |

Field agents do not use host shell/write/edit. They use `arena_fs`
(read/list/stat/status/diff/write/copy/remove), `arena_git` (branch
status/diff/log/commit/merge/abort/resolve), `arena_exec` (foreground
command/launch under the run lock) and `arena_job` (list/status/output/stop
background jobs), registered as direct functions. The default `toolPolicy: "all"`
also exposes host shell/write/edit, MCP, browser, skill, task/subagent and UI
tools; `toolPolicy: "arena"` keeps the strict allowlist. A spawned helper inherits
the caller's policy. `webfetch`/`websearch`/browser are always allowed and no
target is scope-checked: any host, URL or IP named in the brief is reachable. A
host that exposes only Code Mode may run an `execute` body that calls those tools
and nothing else. In a shared tree, writes and foreground commands serialize with
an exclusive lock file by default; `arena_exec resource=<one file-or-service>`
narrows the lock. In copy-on-write only a host launch serializes. Background jobs
are copy-on-write only and tracked. Git is the version engine; MinGit is downloaded once if it is missing. A
non-git working directory is initialized in place with an `arena baseline` commit
before the first worktree; heavy generated directories are excluded through
`.git/info/exclude`, and a root that cannot be initialized falls back to a shadow
repo in temp. Both paths disable text conversion so each copy is byte-identical to
the target. Text merges use git's three-way merge; binary conflicts are reported and
left untouched. In copy-on-write, writes and static commands do not take the global
run lock; only a launch lease serializes a host process. Foreground commands are
capped at 60 s by default (120 s maximum) and a timeout kills the whole process
tree; a watchdog catches a foreground job that outlives its window, clears the
stale run lock, and returns the seat to idle.
Roots over 5,000 files or 512 MB fail with an actionable message instead of
silently copying a huge tree.

`oracle` posts the confirmed pass/fail observation and its baseline, with
`baselineAt`, `scope` and `writer`. A baseline from before this field or a global
log is rejected. `dead-end` closes a route; `claim` asks the gate to accept the
goal. A `claim` may carry `coverage[]`: the proven part and the explicit boundary.
A coverage claim is accepted on evidence without the end-to-end verification
command, because the command is for the full goal, not for an honest partial close.
`finding` is part of the same-role broadcast and is capped at 1,200 chars;
`status` and `note` remain commentary at 160/600 chars. Structured posts over the
limit are rejected, not silently cut; prose keeps its full text in `meta.detail`.

Two structured records matter:

- A `fact` is deduplicated at post time. The same claim from a second agent returns
  the existing id instead of adding a second line.
- An owner may have one active experiment; different owners may run different
  resources in parallel, and two tests naming the same area serialize. A launch
  whose PID did not change is `invalid`, not a pass, because a single-instance app
  silently reused the old process.

Structured records over their limit are **rejected** with an actionable error; only
prose is clamped, and the full prose travels in `meta.detail` (≤ 4000 chars). This
is deliberate: truncating a command or a request loses the evidence.

The User can attach up to four files (8 MB each) by paste, drag or picker. Images
are downscaled to 1600 px, stored as base64 on the message, rendered as thumbnails
and passed to every agent as real prompt files (`files: [{uri: data:…}]`), not as
links. Agents receive them with the steer prompt that carries the message.

## 5. Safe-point delivery

This is the core guarantee, and the host already provides the primitive
(`session.prompt` / `session.synthetic` with `delivery: "steer"` queues the text
until the agent's next safe point, after the current tool call).

- **Orders** (user, Orchestrator) steer: injected at the next safe point, and
  they wake an idle agent.
- **Peer messages** are injected at the agent's next safe point with
  `delivery: "steer"` while it is working, and batched through the per-agent FIFO
  inbox. A long tool run therefore does not make the agent deaf. When the agent
  is idle, the inbox is flushed as one batch. A request or question mention is
  tagged `MENTION` and wakes an idle target immediately. The reply clock starts
  when the ask actually reaches the target. The asker holds its reply debt until
  the answer arrives or the reply window expires.
- The inbox is capped at 24 items. The oldest are dropped with a visible
  `… N older omitted` line, never silently.
- An agent's own posts publish immediately; it never receives its own message.
- Within a batch, order is post order. Across batches, the room's message ids
  preserve order.

## 6. Continuous room, leave, and budget

- There are no steps, rounds or wake-up counters. An agent gets the kickoff and
  then room traffic at safe points for as long as it chooses to stay.
- No default deadline. `maxDurationMinutes: 0` means the field runs until the User
  stops it or every agent has left. A User-set positive value is an explicit stop
  condition, not an agent budget.
- No global experiment quota. An owner may have one active test; different owners
  may test different resources in parallel, and two tests naming the same area
  serialize. A per-field cap can still be set for a bounded run, but the default is
  `0` (unlimited).
- The referee checks every 2 minutes, or after 90 s of quiet, or after 10 new
  posts. She has no check cap. Deterministic checks run first: a working owner's
  lease is renewed automatically; an idle owner's lease expires after 10 minutes;
  an experiment with no result for 15 minutes while its owner is idle is invalid.
- **Only the User can force an agent out.** The coordinator cannot stop the field,
  and Vera's `report`/`abort` are recommendations. An agent leaves by its own
  decision with `arena_bus action=leave`, or the User removes it with
  `stop Name`/`leave Name` (or the panel stop action). The leave tool returns
  before the session is interrupted, so a successful leave is not reported as a
  failed tool call.
- A left agent is **permanently sealed**. Every prompt path is blocked: User,
  orchestrator, peer, `arena.mention`, coordinator traffic, resume turns and room
  synthetic notices. `unsealSession` refuses a `left` seal. The seal is rebuilt
  from stored state after a process restart, so a left agent cannot wake again.
- No concurrency semaphore: agents are independent. The board shows status, left
  members, elapsed time and Vera's next check, not a step count.

### Working agreement

Every kickoff carries the same rules: the state card is the truth; start in your
assigned lane; `split` lanes must not roam, `race` lanes may duplicate the same
attempt; answer the User and your mentions first; post a `fact` only when it changes
the card; post `take` before a write or launch and `release` when done; never redo a
listed dead end or a prior fact; run probes over 20 seconds in the background; never
go quiet after learning something; a claim ends your work. You leave with
`arena_bus action=leave` when you decide your lane is done. The starter's rule is
separate: starting the field ends its own deep work. Acknowledgments are stored but
never delivered. A lesson is allowed only when your own experiment is not running.

## 7. Claim gate

A `claim` message starts the gate automatically:

1. If the contract declares a verification command, run it on the shared
   workspace and record the real output.
2. Ask one idle peer to try to falsify the claim with one cheap check. A peer that
   cannot break it is a signal, not a proof; a peer that breaks it is decisive.
3. Accept only when: verification passed (when declared), the falsifier failed,
   and the claim carries evidence. Everything else is rejected.

Rejection posts the reason in the room and sends the claimer back to work. A
claim rejected twice is closed; the field continues until the User stops it or
every agent leaves. A `report` recommendation does not close it.

Acceptance posts a `verdict` message, sets the room goal to accepted, and ends
the field. There is no fake success: a field that has no accepted claim stays
open for its agents to report or leave.

## 8. The referee

A dedicated child session (Vera) with the judge model. Her role and contract are
injected **once** as session instructions; each check sends only the compact board
(statuses, left members, last post per agent, open asks, area claims, claims, dead
ends, elapsed time), not the same role/objective block again. She is not asked while
every active seat is working; the lag watchdog handles that. One report is kept for
five minutes instead of being repeated every check. She answers JSON only:

```json
{"action":"continue"}
{"action":"pulse","reason":"why the room needs one question"}
{"action":"report","reason":"what is proven, what is not, and the remaining route"}
{"action":"abort","reason":"a concrete unrecoverable condition, not just a quiet room"}
```

`report` and `abort` are advisories: they post a verdict and the field stays live.
They are not a close. The referee never edits files, never
assigns work and never closes a claim by hand; every claim starts the gate. Her
board entry (`Vera watching`, check count, next check) is always visible in the
panel, so a quiet referee still has a visible job.

## 9. Failure handling

- **Session gone** (reload, crash): recreate it from the stored label/agent,
  inject the agent's notebook and the open claim, and continue. At most twice.
- **Verification throws** (missing command, timeout): treated as FAIL.
- **Falsifier answers with prose**: treated as not falsified.
- **Agent silent while idle**: no automatic nudge. It stays in the room and waits
  for the next peer or User message.
- **Agent leaves**: permanent seal; no prompt path remains.
- **Stop**: only the User can do it. Interrupt every session, post a STOP order,
  persist `stopped`, and close the room. The transcript stays.
- **Reload**: resume running fields from storage; if the state is unreadable,
  mark the run interrupted and say so in the room.

## 10. Persistence and resume

| Key | Value |
| --- | --- |
| `arena:field/<runID>` | `FieldState` JSON |
| `arena:field/meta/<runID>` | `{contract, plan}` |
| `arena:field/latest/<parentSessionID>` | run id |
| `arena:field/sessions/<runID>` | `{label: sessionID}` |
| `arena:field/bind/<sessionID>` | `{runID, label, parentSessionID}` |
| `arena/room:<parentSessionID>` | room snapshot (unchanged) |

On load, the service repairs missing sessions, posts a lifecycle notice, and
restarts the driver loop. No duplicate kickoff prompts: each active agent is prompted with
a `Resume:` line only when it has no pending inbox.

## 11. What is removed

`core/protocol.ts` (rounds state machine), `rounds.ts`, the native delegation
flow, the compete/team/evolve drivers, the judge's score table, and the `round`
field on room messages. One mode remains. Copy-on-write uses per-agent git
worktrees from the working directory's repository (initialized in place when it has
none); a shadow repo in temp is the fallback, and MinGit is bootstrapped when git is
missing.

## 12. Non-goals

- Not distributed: one process, one room per session. A same-role copy-on-write
  room has one writable tree per agent plus the shared baseline; a split room may
  still share one tree.
- No automatic merge of partial patches; a merge is a conversation, not an
  operation.
- No automatic application of claims outside the shared tree; agents edit the
  shared workspace directly, like a real crew.
- No second UI framework; the panel stays Solid inside the existing plugin.

## 13. Example

A math problem: C1 (analyst) posts `finding: reduce to the n=3 case`; C3
(adversary) posts `dead-end: induction on n fails at the boundary, do not
retry`; C2 (builder) reads both at its next idle window, posts
`request: @C4 check the boundary case numerically`, and waits; C4 answers with a
counterexample and `replyTo`; C3 turns that into a `dead-end`; C2 posts `claim`
with the counterexample as evidence. The gate runs the verification, asks C1 to
falsify, and accepts when C1 cannot. Vera never assigns any of these tasks.
