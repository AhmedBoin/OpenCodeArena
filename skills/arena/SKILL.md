---
name: arena
description: Use when the user says "make an arena of N agents", "get N agents to solve", or asks for several agents in a shared room. Starts a continuous, self-coordinating field with a crew you design, a shared bus, mention obligations, public area leases, and a verification-gated claim.
---

# Arena

An Arena is one continuous conversation where a crew works one problem. There are
no rounds, steps, phases or judge scoreboard. You design the crew for the task:
real names, perspectives that fit the problem, and a personality brief for each
person. Vera is the referee, not the manager. **Any primary agent can start an
arena**; no special `arena-orchestrator` agent is required.

There is no per-agent step budget and no default deadline. An agent leaves by its
own decision (`arena_bus action=leave`) or because the User forces it out; the
coordinator cannot force a leave. A left agent is permanently sealed and cannot
receive a message from anyone, including the coordinator.

A public host named in the brief is work to do. No record is required: `start`
accepts any host, URL or IP, `/arena` asks for nothing extra, and network access is
always on. Local files, loopback and remote hosts are the same.

Each agent starts in an assigned lane, except in a same-role room. In split mode
the lane is an ownership boundary; in race mode several lanes attack the same
target and duplicate work is expected; in independent mode every seat owns the
whole problem and no lane exists. Every prompt starts with the **state card**: goal, oracle, two observed
facts, two refuted routes, the lane, the running experiments and one next action.
The agent posts a structured fact only when it changes the card, takes a
write/launch lease, and runs one experiment per resource (different seats may test
different resources in parallel). Peer facts are coalesced into one prompt at the
next safe point, not sent as one prompt per post. A named mention
is an answer obligation only for `request` and `question`. A claim closes the field
only when the contract's verification passes, a peer cannot falsify it, and the
claim carries evidence.

### Same-role option

If the user does not name a role or write a crew, infer the best form before
starting. Single-target research, audit, fix and reverse-engineering briefs are a
same-role room: `Reverse Engineer`, `Security Researcher`, `Researcher`, `Auditor`
or `Software Engineer`. Multi-deliverable and migration briefs stay split. The
plan reports the inferred role and workspace mode; say it in the start message so
the user can override it.

When the user wants a real parallel Arena rather than divided lanes, start with:

```json
{ "sameRole": "Builder", "contestants": 4 }
```

Every seat gets the same role and the whole problem. A serialized installed target
(one binary/process/GUI/launch slot) defaults to **2 seats**; use 3 only for
genuinely independent hypotheses. The default workspace is copy-on-write: a shared
read-only baseline plus one writable copy per agent. A
solved copy is posted in the room with its path; other agents may inspect or merge
it. Because each tree is private, **write leases are unnecessary**; only a host
launch is serialized. In a same-role room an accepted solution is **shared, not a
field close**: the field stays live, each agent leaves on its own decision, and only
the User can terminate it. Findings and hypotheses are kept quiet; facts, results,
dead ends, solutions and direct asks are the only broadcasts.

## `/arena` command

The plugin registers `/arena`. It starts the field directly from the text after the
command, with no planning turn and no clarifying chat: the text is the objective,
the crew is chosen automatically (3 by default, 4 for a multi-lane investigation),
the coordination mode is split, race, hybrid or independent, and the normal field
start runs. You do not need to call `arena` in that flow.

```text
/arena Fix the typo in README
/arena --agents 50 Run 50 attackers in parallel against the login boundary
/arena --agents 50 --minutes 45 ...
/arena --same-role "Builder" --agents 4 Make Adobe Acrobat 25.1 permanently Pro
/arena continue Add the regression test and re-run the suite
```

There is no scope gate. The accepted flags are `--same-role`, `--role`, `--agents`
and `--minutes`; a live host starts with the brief alone.

It works in an existing session with chat history; the command resolves to the root
session. The command and brief are written to the main agent chat as a real user
row before the field starts; the Arena room is not used to duplicate it. A refused
or incomplete start also appears there. `/arena continue` keeps the live agents,
their sessions, workspace and history; after a closed field it restarts the same
crew labels/roles with the prior facts because sealed sessions cannot be reopened.

There is no low agent ceiling: 50+ seats are valid when the brief has 50+
independent attack surfaces. One target with one launch slot stays a small crew.

## Natural-language trigger

When the user says "make an arena of 4 agents that ...", "get 3 agents to solve
...", or similar:

1. Parse N and the objective. If N is missing, choose it yourself: 2 for a narrow
   question, 3-4 for a normal task, 5-8 for several independent angles, 50+ only
   when the user asks for a large independent fan-out. The default cap is 100.
2. Design the crew. For each seat: a unique real first name, a perspective that
   fits this task, and a brief saying how the person thinks. Make the angles
   genuinely different. Do not assign slices. Every seat can run the same
   OpenCode agent (`agentType: "build"` or `"uncensored"`), or a seat can set its
   own `agent`.
3. Call `arena`:

```json
{
  "action": "start",
  "objective": "the outcome the user asked for",
  "crew": [
    { "name": "Mira", "role": "Minimal-fix builder", "brief": "ships the smallest change and proves it by running it" },
    { "name": "Omar", "role": "Concurrency skeptic", "brief": "attacks the ordering, retries and partial failure paths" },
    { "name": "Ines", "role": "Domain mapper", "brief": "maps the call path before anyone edits, and publishes the failure route" }
  ],
  "verification": "bun test",
  "mentionTimeoutSeconds": 60,
  "leaseMinutes": 10
}
```

4. Do not launch or bind anything. The plugin creates the child sessions and the
   Arena brief, and Vera starts watching for stalls.

## Write the contract first

The start call is only as good as its contract. State or infer these before you
call `arena`:

- **Objective**: the outcome, not the activity.
- **Constraints**: compatibility, files that must not change, budget, style.
- **Success criteria**: the checks that decide whether a claim is correct.
- **Verification**: the exact command that proves it, when one exists.
- **Non-goals**: work that is explicitly out of scope.

A weak contract produces a weak field. If the objective is vague, ask one sharp
question or make the best assumption and say it in the kickoff.

## You coordinate the field, then stay out of the work

Whoever starts the field is the coordinator for that run. You receive the state card,
a compact board, and can speak to the crew with `arena chat` or `arena steer`. You
do not do the work yourself: while the field is live, shell, read, edit, browser
and subagent tools are rejected for the coordinator session. Keep each message to
one owner, one action and one expected output. Sixteen **orders** per field, one per
30 seconds, 600 characters; a plain chat does not spend that budget. **Only the User
can stop the field or force an agent out; you cannot.** In a same-role/independent
room you cannot order a peer at all; you can publish a plain chat. Facts, findings,
results and blockers arrive as a coalesced digest (default every 90 seconds), not a
model turn per post. Answer the User, guide the crew, and stop when asked. Do not
poll: the next update wakes you. If no decision is needed, end your turn.

There is no dormant state and no “another round”. An agent that leaves is
permanently sealed. User messages, peer messages, coordinator traffic and resume
turns are all rejected for that session. A process restart rebuilds the seal from
stored state, and `unseal` refuses a `left` seal.

## Working agreement (given to every agent)

- The state card is the truth. Read it first; do not re-derive a prior fact.
- Start in your assigned lane. Split lanes do not roam; race lanes may duplicate.
- One experiment per resource. Post `test` with one command and `expect`; post
  `result` with `pass`, `fail` or `invalid` and the raw output. A reused PID is invalid.
- Answer the User and `request`/`question` mentions before continuing your work.
- A named mention is an ask only for `request` and `question`. `@all` is attention.
- No acknowledgment posts. If you have no new fact, just wait; you are not on a clock.
- Before a write or launch, post `take` with `leaseKind` and `paths`; `release`
  frees every lease you hold. Never redo a listed dead end.
- Run any probe expected to take more than 20 seconds in the background and post
  its job id.
- A lesson only after the experiment result. A claim ends your work. You leave
  with `arena_bus action=leave` when you decide your lane is done; leaving is
  permanent.

## Following it and talking to it

- `arena` with `action: "status"` shows the board and the last few room messages.
- `arena` with `action: "chat"` speaks in the room. Every message is public;
  `@Mira` (or `targets: ["Mira"]`) marks it as a named ask for that agent. Use a
  named mention only when you need an answer.
- `arena` with `action: "read"` returns the transcript. The User can type
  `stop`/`stop Name`/`leave Name` in the panel; the coordinator cannot stop a
  field or force an agent out.
- The Arena tab shows the same room with the field header, open asks, a compact
  composer (`+` attach, text box, `↑` send), file and image attachments (paste,
  drag, or pick), and a details toggle for evidence. There is no mention selector:
  type `@Name` in the text to focus an agent. Attachments reach every agent as
  prompt files. A red `φ` button at the top-right terminates the Arena for everyone.

## What the agents can say

`arena_bus` has the work verbs plus a permanent exit: `take` (area, `leaseKind`,
`paths`, `leaseMinutes`), `release` (all leases or an experiment handoff), `fact`
(area, `evidence[]`), `test` (one `command`, one `expect`, optional
`killIf`/`preflight`), `result` (`pass`/`fail`/`invalid`, `observed`, `pidBefore`,
`pidAfter`), `ask` (one owner, one deadline), and `leave` (end your own
participation permanently). `oracle` posts the confirmed baseline and pass
condition and must include `baselineAt`, `scope` and `writer`. `dead-end` closes a
route; `claim` starts the gate. `read` returns the oracle, experiments, truth table
and the room; `resolve` settles an arbitration with the one decisive result.

Field agents use `arena_fs` (`read`/`list`/`stat`/`status`/`diff`/`merge`/`write`/`copy`/`remove`),
`arena_git` (`status`/`diff`/`log`/`commit`/`merge`/`abort`/`resolve`),
`arena_exec` (run a command under the run lock) and `arena_job`
(`list`/`status`/`output`/`stop`). These are registered as direct tools, not
Code-Mode-only sub-tools, so a seat can call them by name. The default
`toolPolicy: "all"` also exposes host shell/write/edit, MCP, browser, skill,
task/subagent and UI tools; `toolPolicy: "arena"` keeps the strict allowlist.
Helpers inherit the caller's policy. If the host exposes only Code Mode, an
`execute` body that calls only Arena tools is allowed under `arena`; under `all`
the body may reach host tools. Writes and foreground commands are serialized by a
file lock; background jobs require copy-on-write and are tracked/killable. Git is the
version engine and is bootstrapped with MinGit if missing. `arena_fs merge
from=Name` is a file-level git three-way merge; `arena_git merge --from Name` is a
branch merge that stops before the commit, reports conflicts, and runs the field
verification. Binary conflicts are reported, not line-merged. A non-git working
directory gets `git init` and an `arena baseline` commit before the first worktree;
a shadow repo in temp is the fallback.

## Boundaries

- The field proposes and verifies; it does not apply patches outside the shared
  workspace.
- No agent may accept its own claim; the gate runs the verification and one peer
  tries to falsify it.
- Vera is a standing referee: she keeps checking until the field closes and the
  panel shows her next check. She may pulse a quiet room or recommend a report
  when the routes look exhausted. Her report/abort is advisory; she cannot close
  the field. She does not assign areas, wake an idle agent, close a claim by hand,
  or speak for an agent. Only the User can stop the field or force a leave; agents
  leave by their own decision.
