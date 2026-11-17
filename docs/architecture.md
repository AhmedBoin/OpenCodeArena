# Arena architecture

The arena is a plugin around a small host port. Everything that decides behaviour
is host-neutral; only the adapter and the panel know OpenCode.

```
src/core/          field state, inbox, gate, knowledge     pure, clock injected
src/field/         roster, prompts, FieldRun driver        host-neutral via FieldDeps
src/service.ts     rooms, sessions, storage, hooks, resume
src/host/port.ts   the port a harness implements
src/host/opencode.ts the OpenCode adapter
src/plugin.ts      entry: tools, slash commands, hooks, RPC, service cache
src/gui.tsx        the Arena panel
```

`src/core/**` imports no `@opencode/*`, touches no global and receives `now`.
`FieldRun` imports `core/` and `types.ts` only and reaches the host through
`FieldDeps` (prompt, wait, info, finalText, usage, interrupt, verify, post,
save, cancelled). `ArenaService` implements `FieldDeps` with real sessions,
rooms and storage. A second harness writes one adapter; the field does not
change.

## One run, one loop

```
/arena <problem> (plugin slash command; works in any session)
  echo the command to the main agent chat as a user row before work starts
  resolve the invoking session to its root
  service.startFromCommand(): strip command, analyzeBrief, choose 3-4 crew
  startField

/arena continue <mission>
  reuse the live FieldRun, sessions, workspace and history
  update the contract and prompt every non-left member with the new mission
  if the old field is closed, start a new run with the same crew labels and prior context

startField
  planRun(): coordination mode (split / race / hybrid / independent), lanes, hypotheses, oracle
  load prior memory for the same objective
  create named sessions + Vera the referee
  open field state, room participants, goal, facts board, oracle
  seed prior facts as `assumed`
  FieldRun.start(): one kickoff prompt per agent: state card + lane + protocol
  service poll (1.5 s): field.tick()
```

`tick` is the only clock. It:

1. stops only if the User set a positive deadline,
2. renews every active lease owned by a working member,
3. expires unanswered mentions and idle leases without a forced close,
4. flushes an idle agent's inbox when the debounce elapsed,
5. runs the referee check every `checkEveryMs`, when the field is quiet, or
   after ten new posts,
6. batches decision-relevant room activity to the coordinator,
7. posts a no-progress advisory on a quiet field,
8. ends the field only when every agent has left, and
9. never nudges, wraps up or marks a dormant state.

Room traffic is coalesced per agent: P0 (user/order) steers immediately, P1
(named mention) waits one flush window, P2 (peer facts) waits two. One prompt
carries the batch, not one prompt per post. Writes and launches pass through a
lease guard (`grantLease` / `checkLease`); a second owner is refused before the
tool runs, and `release` frees every lease the caller holds. Only the command verb
is a launch: `Get-Process Acrobat` is a read.

There is no semaphore, round counter or per-agent step budget. Agents are
independent; the referee has no check cap by default.

A `sameRole` plan gives every seat the same role and the whole problem, with
`workstream` unset. It is also inferred when the user gives no role/crew and the
brief is a single-target research, audit, fix or reverse-engineering task
(`Reverse Engineer`, `Security Researcher`, `Researcher`, `Auditor`,
`Software Engineer`). Multi-deliverable and migration briefs stay split. A
serialized installed target (one binary/process/GUI/launch slot) defaults to two
seats; an explicit `contestants` value overrides it. Its default workspace mode is
`copy` for up to eight seats: one shared read-only baseline plus a per-agent git
worktree. A home/drive root that cannot isolate refuses a same-role room above two
seats before any session exists. Git is the version engine. If git is
missing on Windows, `git.ts` downloads the official MinGit build into Arena's tools
directory and extracts it with the built-in Windows archiver. A non-git working
directory is initialized in place and committed as an `arena baseline` before the
first worktree; heavy generated directories are excluded through
`.git/info/exclude`. A root that cannot be initialized falls back to a shadow
repository in temp. Both paths disable `core.autocrlf` and path text conversion,
so a copy is byte-identical to the target (important for binaries and for
hash-based evidence).
File writes to the shared baseline are refused
by the tool guard; each agent edits its own copy and publishes the path. An accepted
solution is a broadcast, not a close; a claim may carry `coverage[]` for an honest
partial result; the field stays live until every agent leaves
or the User terminates it.

Field agents mutate through `arena_fs` (read/list/stat/status/diff/write/copy/remove),
`arena_git` (branch status/diff/log/commit/merge/abort/resolve), `arena_exec`
(foreground command/launch, default 60 s, max 120 s) and `arena_job` (tracked
background jobs). The tools are registered as direct functions, not Code-Mode-only
sub-tools. The default `toolPolicy: "all"` exposes host shell/write/edit, MCP,
browser, skill, task/subagent and UI tools alongside Arena; `toolPolicy: "arena"`
keeps the strict allowlist (arena tools, read/grep/glob, webfetch/websearch,
skill and a bounded `arena_spawn`). A spawned helper inherits the caller's policy.
Web/browser fetches are always allowed and no target is scope-checked: any host,
URL or IP named in the brief is reachable. A
Code Mode `execute` body
is allowed only when it calls Arena tools and nothing else. A foreground timeout
kills the process **tree**, not just the shell; a per-seat watchdog also catches a
job that outlives the stall window, releases the run lock, and returns the seat to
idle.
`core/mutex.ts` serializes every `arena_fs` mutation and foreground `arena_exec`
with an exclusive lock file in the Arena temp directory **in a shared tree**. In
copy-on-write each seat owns its worktree, so static commands and writes do not
take the global lock; only a launch lease serializes the host process. The start
message and every seat prompt say which mode is actually active; a home/drive root
that cannot isolate starts as shared and does not claim a private copy. Background
jobs are allowed only in copy-on-write mode, are tracked by pid/output/exit status,
and are stopped by `arena_job` or field cleanup. Versioning, status, diff and
three-way merge are git operations; binary files are never line-merged and
conflicting binary changes are reported as conflicts instead of overwritten.

The parent session is the coordinator. It receives the same 18-line state card plus
a coalesced digest of facts, findings, results and blockers, with `delivery: "steer"`,
so a busy coordinator gets it at its next safe point and an idle one is woken. It
does not poll. Its messages are limited to sixteen **orders**, one per 30 seconds,
600 characters, and exactly one owner; a plain chat does not spend the order budget.
A same-role room refuses an order entirely and accepts a plain broadcast chat.
It **cannot stop the field or force an agent out**; those are User-only paths.
While its field is live, an `execute.before` tool guard rejects shell, read, edit,
browser and subagent calls for that session, so it can monitor and speak through
`arena` but cannot quietly do the work itself. UI-only `deck_progress` and
`question` are allowed because they do not touch the project. Field seats get the
Arena tools as direct functions; if a host exposes only Code Mode, an `execute`
body that calls only Arena tools is allowed, while a body that reaches host tools
is rejected.

A left agent is **permanently sealed**. A global registry outside the service
instance (the `src/seal.ts` gate) blocks every prompt to that session: User,
orchestrator, peer, `arena.mention`, coordinator digest, resume, and room
synthetic notices. The registry is rebuilt from persisted field state after a
process restart, and `unseal` refuses a `left` seal. Only a fresh field/session can
bring that work back.

The service cache is keyed by the **project directory**, not the session directory.
A field seat runs in a worktree, and OpenCode loads the plugin again for that
location; keying by the worktree produced one driver per seat, all resuming the
same field. One project root now means one service and one tick loop.

On a plugin hot reload in the same process, the new service **adopts** the live
run: it takes over the tick loop without re-prompting the agents and without a
second "resumed after a reload" message. A real process restart still performs the
full resume path and restarts the agents' turns.

## Safe-point delivery

Two lanes, by design:

- **Orders** from the User or the Orchestrator (the main session that started
  the field; any primary agent can be that session) are prompted with
  `delivery: "steer"`. The host injects them at the agent's next safe point,
  after the command that is running.
- **Peer facts** are broadcast to every member's per-agent FIFO inbox
  (`core/inbox.ts`, cap 24). While the agent is working, the driver batches the
  inbox and injects it with `delivery: "steer"` at the next safe point. When the
  agent is idle, it flushes the same batch and starts a turn. A named `@Name`
  mention wakes an idle target immediately, and the reply clock starts when the
  ask reaches the target. `@all` adds a `MENTION` tag for attention with no
  reply debt.

The agent's own posts publish immediately. Inbox order is post order; dropped
messages are counted and shown. This is what makes "inside a command" safe: the
driver cannot inject mid-command. The driver also keeps a 500-entry delivery
ledger (queued, delivered, latency, truncation); the board and `arena status`
expose p50/p90 latency and the truncation count.

## The field state

`core/field.ts` owns the data: members (label, agent, stance, session, status,
`leftAt`/`leftBy`, notebook), mention requests, area intents, lessons, open
claims, posts and dead-end counts, usage, optional deadline and `closed`. Helpers
return new state; the driver saves after every change.

`FieldRun` owns the volatile parts: inboxes, busy set, last post per member, the
gate chain and the referee clock.

## The claim gate

A `claim` post stores a `FieldClaim` and awaits `runGate`, serialized through one
promise chain. The gate:

1. runs the contract's verification command on the shared workspace (skipped for a
   coverage claim, whose evidence names the partial boundary),
2. asks one idle peer to falsify the claim (one cheap check, JSON answer),
3. calls `judgeClaim` (`core/gate.ts`),
4. posts a `verdict`, accepts or rejects, and returns the claimer to work on a
   rejection.

Acceptance sets the goal accepted, marks every member done, interrupts working
sessions and stops the loop. No acceptance is written without evidence.

## Attachments

The panel reads a pasted, dropped or picked file as base64, downscales images to
1600 px, and sends up to four files with the message. The service stores them on
`meta.attachments`, renders them from the snapshot, and `FieldRun.publish` passes
them to every agent as prompt files (`uri: data:<mime>;base64,…`). Nothing is
stored on disk by the plugin.

## Rooms and persistence

- `arena/room:<parentSessionID>` is the transcript (messages, participants,
  goal, closed). `ArenaRoom.absorb` unions by id and never loses a write when two
  instances meet.
- `arena:field/<runID>`, `.../meta`, `.../latest/<parent>`, `.../sessions`,
  `.../bind/<session>` are the field state.
- `saveField` writes the state and mirrors member status into the room.
- A reload rebuilds rooms, repairs missing sessions (create, bind, inject the
  notebook), posts "resumed after a reload" and resumes idle members once.
- `sweepFields` (every poll) replaces a session that vanished mid-run.

## Panel

The tab consumes `FieldBoard` over RPC (`snapshot`, `send`, `board`, `wait`) and
the server event stream. The header is the board; the transcript is the room.
Details live behind the message details toggle. The bridge debounces refetches
and falls back to a long poll.

## Failure handling

| Failure | Behaviour |
|---|---|
| Agent mid-command | message waits in the inbox |
| Agent silent | no automatic nudge; it waits for the next message |
| Agent leaves | permanent seal; no prompt path remains |
| Mention unanswered | asker gets the expiry prompt and continues |
| Session lost | recreated with notebook, unless the member had left |
| Verification throws | FAIL |
| Peer falsifier answers prose | not falsified |
| Referee answers prose | one repair, then continue |
| Stop | User-only; interrupt all, STOP order, close room |
| Reload | resume, or mark interrupted |

## Porting

Only three things are harness-specific: the plugin entry, the panel bundle and
the adapter. `docs/porting.md` lists the port members and the capability flags.
