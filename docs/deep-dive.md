# Multi-agent arena on OpenCode: deep dive and implementation

> Historical note: this document describes the first design and the incident research that motivated the redesign. The current native, cooperative, background arena is described in `architecture.md`. Some 1.x containment recommendations (Docker, strict blinding) are deliberately not part of the current design, and the 1.x file list in section 11 no longer matches `src/`.

This document answers one question: how do you build a real multi-agent arena inside OpenCode, using what the platform actually provides, without pretending it can do things it cannot.

The short version:

- The arena idea is sound, but only if it stops on reproduced evidence, not on agreement.
- OpenCode has the primitives: isolated child sessions, per session models, a prompt inbox with an explicit wait, keyed context injection, durable plugin storage, permission rules, and worktrees.
- OpenCode cannot create agents at runtime. A "new agent" is a new session running an existing agent with its own prompt, model, and permissions.
- Every public arena plugin I checked targets the 1.x API. The 2.x API changed the package name, the config key, the tool registration path, and the event payload shape. Copying 1.x code will not load.
- The hard parts are not orchestration. They are verification, isolation, and stopping rules.

A working implementation ships beside this document in `arena/`.

## 1. Separate the three claims

The pitch usually mixes three claims that fail for different reasons.

1. **Diversity helps.** Several independent attempts raise the chance that one is right. This is the best-supported claim. It is essentially best-of-n sampling with different prompts and models.
2. **Critique helps.** Adversarial review surfaces errors a single pass misses. This is plausible but fragile: models tend to agree with confident peers, and they share training data, so they share blind spots.
3. **Consensus identifies truth.** This is false. Voting cancels independent noise. It does not cancel correlated error. Three agents that learned the same wrong idiom will agree confidently and be wrong together.

A useful arena therefore does not treat agreement as a signal of correctness. It treats execution as the signal:

- every claim must carry a command that was actually run and its real output;
- every attack must name a falsifying test;
- the judge reruns the verification command and the serious attacks;
- the judge may reject every candidate;
- the winner needs a score above a pass mark and a margin over the runner up, not just the top rank.

That single change, from "who argued best" to "what did the judge reproduce", is what makes the difference between a demo and a tool.

## 2. Prior art, verified

I checked the projects named in the brief against their repositories and npm metadata on 2026-11-11.

| Project | Latest | API generation | What it does | What it teaches |
|---|---|---|---|---|
| `open-conclave` | 0.1.0, MIT, 15 stars | 1.x (`@opencode-ai/plugin` 1.0.85) | Three persona debaters (Harper, Benjamin, Lucas) plus a Captain, structured JSON per debater, up to 3 rounds, stops when the Captain's consensus score is at least 0.83 | Personas and JSON contracts are cheap and effective. Consensus as a stop rule is the weak point. |
| `opencode-sessions` | 1.0.0, MIT, 180 stars | 1.x (`@opencode-ai/sdk` ^0.15.18) | One `session` tool with four modes: message, new, compact, fork. Agent handoff and parallel exploration | A tool cannot prompt the session it is running inside. The 1.x implementation stores the pending message in `tool.execute.before` and delivers it on the `session.idle` event. This is the single most important implementation trap. |
| `opencode-ensemble` | 0.20.0, MIT, 259 stars | Dual: 1.x plus a 2.x `Plugin.define` path | Agent teams, SQLite state, task board with dependencies, one git worktree per teammate, dashboard on port 4747, `promptAsync` delivery, nudges on idle | Isolation is a first class problem. Concurrent edits need worktrees, not good intentions. Also: delivery is event driven, and an idle teammate needs a nudge or it silently stalls. |
| `@rrr2010/opencode-roundtable` | 0.3.9 | 1.x peer (`@opencode-ai/plugin` latest) | Round robin debate, agents speak in sequence and see the transcript, an observer consolidates, state persisted to disk, Jaccard similarity detects loops, returns `{sessionID, summary}` after conclusion | A blocking orchestrator tool works and is acceptable UX. Loop detection matters more than round count. |
| "Claude Arena" | n/a | Claude Code skill, marketed on social media | The viral framing: many agents attack the same problem, then compare | It is a protocol idea, not an OpenCode dependency. Do not treat marketing claims as architecture. |
| Product Hunt "Duelin' Agents" | n/a | unrelated product | A demo of two models chatting in public | Not an OpenCode project. The ChatGPT summary conflated it with the plugins above. |

Two conclusions:

- **None of the named OpenCode projects is a verification arena.** Conclave is debate with a consensus threshold. Roundtable is debate with a summary. Ensemble is task delegation with a shared board. Sessions is session plumbing. Each solves one piece. None makes an independent judge reproduce evidence and reject all candidates.
- **Most of them are 1.x artifacts.** In the 2.x API the package is `@opencode/plugin` (version aligned with the CLI, 2.2.7 here), the config key is `plugins` not `plugin`, tools register through a transform, and events carry `data.sessionID` instead of `properties.sessionID`. A 2.x-only host will not run 1.x plugin code. Ensemble is the exception: it ships both a 1.x `server()` path and a 2.x `Plugin.define` path, with most behavior still on the 1.x side in the version I read.

## 3. The substrate, verified against OpenCode 2.2.7

Everything below comes from the current plugin docs and the generated types installed in `node_modules`, not from memory.

### 3.1 Sessions are the unit of isolation

```ts
const created = await ctx.session.create({
  title: "arena run C1",
  parentID: parentSessionID,
  agent: "build",
  model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" },
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  metadata: { arenaRun: runID, arenaRole: "contestant" },
})
```

`parentID` nests the child in the UI, `agent` picks the profile, `model` picks the model for that session, `permissions` is a server enforced ruleset where the last matching rule wins. That is enough to run one `build` agent as six different competitors on six models without creating six agent definitions.

### 3.2 A prompt is an inbox admission, not a turn

```ts
await ctx.session.prompt({ sessionID, text })
// returns Session.Inbox.User: an inbox item with an id, not the answer
await ctx.session.wait({ sessionID })
// experimental, returns 204 when the session is idle
const messages = await ctx.session.context({ sessionID })
// read the last assistant message from here
```

This is the mistake that breaks most first attempts. `prompt` queues work. If you read the session immediately, you get the previous turn or nothing. You must wait, then read. `wait` is marked experimental in the 2.x API and there is no timeout parameter, so wrap it in a race and interrupt on timeout.

Competitor output is in the assistant message `content` array, in parts with `type: "text"`. Reasoning and tool parts must be ignored when you parse the answer, or you will try to JSON parse a reasoning block.

### 3.3 Events changed shape between 1.x and 2.x

2.x API events carry their payload under `data`:

```ts
ctx.event.subscribe({ types: ["session.execution.succeeded", "session.execution.failed", "session.usage.updated"] })
```

- completion: `session.execution.succeeded` with `data.sessionID`
- failure: `session.execution.failed` with `data.sessionID` and `data.error`
- idle: `session.idle` with `data.sessionID`
- spend: `session.usage.updated` with `cost` and `tokens`

1.x code reads `event.properties.sessionID`. That field does not exist in the 2.x API. The sessions plugin, written for 1.x, is built entirely around that field.

### 3.4 You cannot add an agent at runtime

`ctx.agent.transform` exposes `list`, `get`, `default`, `update`, and `remove`. There is no `add`. A plugin cannot invent a new agent profile.

This kills the naive reading of "dynamic agent spawning". What you can do is create a new session running an existing agent with a different prompt, model, permissions, and parent. That is functionally a new worker, and it is what the helper escalation in the implementation does. It is not a new agent in the catalog, and it will not appear in the agent picker.

If you want real named agents, ship markdown files under `.opencode/agents/` or a global `agents/` directory. That is configuration, not runtime.

### 3.5 Context injection without a user turn

Two mechanisms matter:

```ts
await ctx.session.instructions.entry.put({ sessionID, key: "arena/contract", value: {...} })
await ctx.session.instructions.entry.remove({ sessionID, key: "arena/contract" })

ctx.session.hook("context", (event) => {
  event.system.push({ type: "text", text: "..." })
})
```

Instruction entries render as `<context key="...">` blocks and replace by key. That is ideal for the contract, the stance, and escalation answers: they are persistent, cheap to update, and do not queue a turn. The `context` hook runs on every model call and is better for invariant rules you must reassert, at the cost of doing work on every step.

The implementation uses instruction entries for the contract and escalation answers, and puts the round material in the prompt itself, because it changes every round and benefits from being adjacent to the task.

### 3.6 Tools register through a transform

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "arena",
    description: "...",
    input: {
      type: "object",
      properties: { objective: { type: "string" } },
      required: ["objective"],
      additionalProperties: false,
    },
    options: { codemode: true },
    execute: async (input, context) => {
      // context.sessionID, context.agent, context.signal, context.progress
      return { content: "..." }
    },
  })
})
```

`input` accepts JSON Schema, a Standard Schema, or an Effect schema. `execute` returns `{ content, metadata }`. `content` may be a string or an array of text and file parts. `context.progress` updates the tool status in the UI. `context.signal` aborts when the tool is stopped, which you must wire to `session.interrupt` or competitors keep burning tokens after the user cancels.

The 1.x `tool: { ... }` map in the returned plugin object does not exist in the 2.x API. That is why the version of ensemble I read still carries its behavior in the 1.x `server()` path while its 2.x `setup()` initializes state and defers tool registration.

### 3.7 Storage is durable JSON, scoped to the plugin

```ts
await ctx.storage.set("runs/abc", JSON.stringify(payload))
const page = await ctx.storage.scan({ prefix: "runs/", limit: 25 })
```

Values are JSON. I store serialized strings to keep the full transcript and result together without fighting the JSON type at every nested optional field. It survives restarts and is the cheapest durable audit log available to a plugin.

### 3.8 Worktrees exist, and need a project

```ts
const created = await ctx.worktree.create({ projectID: ctx.location.project.id, name: "arena-c1" })
await ctx.session.create({ ..., location: { directory: created.directory } })
```

This is the only honest way to let competitors edit in parallel. It requires a git project and a `projectID`. This repository is not a git repo, and more importantly, a wrong merge is worse than no merge, so the default mode is proposals only. Worktree mode is a deliberate next step, not a checkbox.

## 4. Constraints that decide the architecture

| Constraint | Consequence in the design |
|---|---|
| `prompt` is admission, `wait` is separate | The orchestrator is a blocking loop: prompt, wait with timeout, read, parse. No polling of message text. |
| A tool runs inside a session | Never prompt the session the tool runs in. Child sessions only. This is the deadlock the sessions plugin dodged in 1.x by deferring to `session.idle`. |
| All sessions share a working directory by default | Competitors do not edit files. They submit patches as text. Evidence comes from read only commands. |
| Agents cannot be added at runtime | Diversity comes from stance prompts plus per session models, not from new agent profiles. |
| Event payloads moved to `data` | Never copy 1.x event code. Read `data.sessionID`. |
| `wait` has no timeout | Race it, abort the request, then `session.interrupt`. |
| Cost and tokens live on the session | Budget is measurable, not estimated. Check it between rounds. |
| Permission rules are last match wins | Put the broad allow first, then the specific deny. |
| Judge sessions accumulate context | Create a fresh judge session each round so round two is not anchored by round one. |

## 5. The protocol

```
brief
  |
explore        N isolated sessions, no cross visibility
  |
disclose       append submissions to the blackboard
  |
cross exam     each competitor sees blinded rivals, must file falsifiable attacks
  |
revise         attacked competitors change the claim or defend it with evidence
  |
judge          fresh session, different model, reruns verification and attacks
  |
verdict        accept only if verified, above pass mark, above margin, no fatal flaw
  |
  +--> next round with the judge's focus, or stop
```

### 5.1 Submission contract

```json
{
  "approach": "the method in one or two sentences",
  "claim": "what this achieves against the success criteria",
  "patch": "unified diff or exact edit instructions",
  "evidence": [{ "command": "exact command", "result": "real output" }],
  "assumptions": ["unverified belief this depends on"],
  "risks": ["realistic way this fails"],
  "confidence": 0.0,
  "escalate": ["one bounded sub-question"]
}
```

`confidence` is recorded and never scored. Self reported confidence is the least reliable field in the document.

### 5.2 Cross examination contract

```json
{
  "attacks": [
    { "target": "C2", "claim": "the disputed claim", "test": "the check that would falsify it", "severity": "fatal" }
  ],
  "defense": ["a specific attack on you and the evidence that answers it"],
  "changedMind": false
}
```

Rules enforced by the parser and the prompt:

- at least one attack is required, "all fine" is not a review;
- an attack without a test is dropped, because it is an opinion;
- a target that is not a current rival is dropped with a warning, because it is a hallucination;
- severity `fatal` means a violated success criterion or a crash, `major` means wrong in a realistic case, `minor` means correct but costly.

### 5.3 Verdict contract

```json
{
  "decision": "accept",
  "winner": "C2",
  "scores": [
    { "candidate": "C1", "correctness": 4, "evidence": 4, "robustness": 3, "simplicity": 4, "assumptions": 3, "fatalFlaws": [], "notes": "what was verified" }
  ],
  "reproduced": [{ "command": "bun test", "result": "12 passed" }],
  "reasoning": "why, citing what was verified",
  "nextRoundFocus": "the one thing the next round must resolve"
}
```

The parser rejects a verdict that omits a candidate, accepts without naming a winner, or rejects all while naming one. A judge that cannot follow the contract gets one repair attempt, then the run is marked aborted rather than silently degraded.

### 5.4 Stop rule

```ts
score = (correctness*0.40 + evidence*0.30 + robustness*0.15 + simplicity*0.10 + assumptions*0.05) / 5 * 100
```

Stop with `accepted` only when all of these hold:

1. the judge said `accept`;
2. the winner has no reproduced fatal flaw;
3. the winner's score is at least the pass mark (default 70);
4. the winner leads the best non disqualified runner up by at least the margin (default 8 points).

Otherwise run another round, up to the limit. On the last round the result is `inconclusive` or `rejected_all`, and the report says so. There is no case where the top ranked candidate wins by default.

This is deliberately stricter than every project in the survey. Conclave stops when the Captain reports consensus. Roundtable stops when rounds run out. Neither requires a reproduced pass.

## 6. Mapping: need to API to code

| Need | OpenCode primitive | Code |
|---|---|---|
| Isolated competitor | `session.create({parentID, agent, model, permissions})` | `runtime.createSession` in `src/plugin.ts` |
| Independent first round | separate sessions, no board entries yet | `src/orchestrator.ts` explore phase |
| Wait for an answer | `session.prompt` then `session.wait` | `runtime.prompt`, `runtime.wait`, `ask()` |
| Read the answer | `session.context`, text parts of the last assistant message | `src/text.ts` |
| Persistent contract | `session.instructions.entry.put` | `runtime.inject` |
| Cross visibility | blinded labels plus rotated order | `src/blackboard.ts` |
| Durable transcript | `ctx.storage.set("runs/<id>")` | `remember()` in `src/plugin.ts` |
| Budget | `session.get().cost` and `.tokens` | `src/budget.ts` |
| Timeout | race, abort, `session.interrupt` | `runtime.wait` and `ask()` |
| Cancellation | `context.signal` then interrupt every created session | `onAbort` in `src/plugin.ts` |
| Nested run guard | session id set | `activeSessions` in `src/plugin.ts` |
| Helper for a blocker | new session with `agent: "explore"` | escalation block in `src/orchestrator.ts` |
| Judge independence | fresh session per round, different model | judge block in `src/orchestrator.ts` |

## 7. Judging design

The judge is the part most implementations get wrong. Four rules:

**Blind.** Competitors get labels `C1` to `CN`, assigned by a seeded shuffle of the internal ids. Labels are stable across rounds so a competitor can defend what it said, but presentation order rotates per viewer and round so no label is always first. The judge sees labels only: no model names, no session titles, no provider names. Prestige bias is real when one candidate is known to be the expensive model.

**Fresh.** One judge session per round. A judge that scored round one will anchor on its own verdict. The cost is one extra session per round, and it is worth it.

**Different.** Supply `judgeModel` from a provider no competitor uses. If you do not, the result notes say the judge shares a model with a competitor and that agreement should be treated with suspicion. The implementation records this rather than hiding it.

**Accountable.** The judge must list the commands it ran and their output. The rubric anchors are explicit: 0 absent, 3 adequate, 5 exemplary and verified. Disqualification requires a fatal flaw the judge reproduced or that the candidate's own evidence shows. Style is not a flaw.

A judge can reject every candidate, and should when the success criteria are unmet. `reject_all` is a valid, recorded outcome, not an error.

## 8. Isolation, safety, and cost

**Proposal mode (default).** Competitors may read and run commands, but `edit` is denied. They return a patch. This avoids concurrent writes to one working directory and keeps the comparison fair. The cost is that nobody proves the patch applies; the judge can still run the verification command against the current tree, which is useful for diagnosis tasks and weaker for applied fixes.

**Worktree mode (not implemented).** One worktree per competitor, session location pointed at it, judge compares diffs and merges the winner. Requires a git project and a `projectID`. Ensemble does this well and its code is the reference.

**Permission rules.** The arena denies `edit`, `subagent`, and its own tool action `arena` for competitors and the judge. Denying `subagent` stops a competitor from delegating its way around isolation, and denying `arena` is a second line of defense against recursion; the plugin also refuses a nested call by tracking the session ids it created, because a permission action name is not guaranteed to match a custom tool name in every version.

**Cost.** A run of N competitors and R rounds performs roughly `N * R * 3 + R` model turns: explore, cross exam, revise, plus judging. With N=3 and R=2 that is about 20 turns, and every turn carries a full session context. The default budget is 1.5 USD and is checked between rounds. One round can overshoot; a global deadline is future work.

**Time.** Parallel phases cost wall clock equal to the slowest competitor, not the sum. Per session timeouts default to 240 seconds for competitors and 300 for the judge. A timed out competitor is interrupted and recorded as an invalid submission; the round continues.

## 9. Failure modes and mitigations

| Failure | Symptom | Mitigation in the code |
|---|---|---|
| Sycophancy | later rounds converge on the first confident voice | blind labels, rotate order, judge scores evidence not rhetoric |
| Collusion | competitors split the problem and agree not to attack | explicit rule, every competitor must attack, the judge sees the attacks |
| Shared blind spot | all candidates miss the same case | stances include an adversary, the judge is told consensus is not evidence |
| Evidence fabrication | plausible output for a command never run | judge reruns verification and serious attacks, `reproduced` is required |
| Format drift | prose around JSON, or a missing field | tolerant extraction, strict validation, one repair attempt, invalid is recorded |
| Context rot | round three ignores round one | compact digest with a character budget, keyed instruction entries |
| Edit collisions | two competitors write the same file | `edit` denied by default, worktrees for the opt in path |
| Runaway cost | one run drains the balance | per session accounting, budget gate between rounds, hard caps on N and R |
| Judge capture | judge rewards the longest answer | anchors, blind labels, reproduction requirement, reject_all |
| Timeout | a session never goes idle | race, abort, interrupt, invalid submission |
| Nested recursion | competitors spawn arenas | `subagent` denied, active session set checked at the tool entry |
| Session leak | dozens of children left behind | `keepSessions` option, explicit remove loop |

## 10. Alternatives considered and rejected

**Use the built-in `subagent` tool only.** It is designed for delegation: one prompt, one result, no shared board, no explicit wait primitive, no per competitor model choice from inside a single tool call. It cannot express "all four attack each other, then a fifth judges". Sessions can.

**One session with several agents taking turns.** Cheapest to build, worst correctness: every agent sees the others immediately, so round one is not independent, and there is no blinding. The sessions plugin's message mode is this design, and its own README warns about mixed providers.

**A file based message bus.** Durable and inspectable, but concurrent writes, stale reads, and locking are a project of their own. Plugin storage plus an in memory blackboard covers one run, and the transcript is persisted at the end.

**SQLite like ensemble.** Correct for teams that survive restarts and need queries. Overkill for a run that lasts minutes; it also forces Node 24 or Bun for the sqlite module.

**Stop on consensus like conclave.** Rejected for the reason in section 1. It is the fastest way to ship a confident wrong answer.

**Let the judge write code.** Tempting, but it blurs the separation between evaluating and solving. The judge runs commands; the winner's patch is applied by the caller after review.

**Merge the top two automatically.** Attractive and dangerous: merges of two incompatible fixes are how you get a third bug. Merging is allowed inside a competitor's revision, where a single agent owns the result, and the judge scores that result.

## 11. What is implemented, and what was verified

The package in `arena/`:

| File | Responsibility |
|---|---|
| `src/types.ts` | domain types, six stances, defaults |
| `src/config.ts` | clamping, stance selection, seeded stance rotation |
| `src/json.ts` | tolerant JSON extraction, strict submission, cross exam, and verdict validation |
| `src/scoring.ts` | weights, ranking, the stop rule |
| `src/blackboard.ts` | labels, rotation, budgeted digest |
| `src/budget.ts` | usage math and the budget gate |
| `src/prompts.ts` | explore, cross exam, revise, judge, repair, escalation prompts |
| `src/text.ts` | final assistant text extraction |
| `src/orchestrator.ts` | the protocol loop over an injected runtime |
| `src/model.ts` | `provider/model#variant` parsing |
| `src/plugin.ts` | plugin wiring: tool, sessions, storage, abort, recursion guard |

Verification actually run, with results:

- `bun test`: **58 pass, 0 fail**, 7 files. Includes a full two competitor arena driven by a scripted fake runtime, and a plugin level test that registers the tool against a mock plugin context, runs an arena end to end, and asserts that the run was stored. A separate test makes storage fail and confirms the paid result is still reported.
- `bunx tsc --noEmit`: **exit 0** against `@opencode/plugin` 2.2.7, the same version as the installed CLI.
- The typecheck is the real proof that the calls match the plugin signatures: `session.create` with `model`, `permissions`, `parentID`; `prompt` with `text`; `wait` with a request options signal; `instructions.entry.put`; `context`; `get`; `interrupt`; `remove`; `tool.transform`; `storage`.

Not verified, and stated as such:

- **Not loaded into a live OpenCode server in this session.** Doing so means editing the live config and spending model tokens, which was not requested. Section 12 is the exact procedure.
- **Real model JSON compliance.** The tests simulate perfect and deliberately broken output. Real models drift more. The repair attempt and invalid submission path exist for that reason, but their real world rate is unknown.
- **Real `wait` behavior under load.** Whether a blocked tool holding a child session open has side effects on the parent session's own queue is unverified. The design uses child sessions only, which is the safe shape.
- **Permission enforcement inside child sessions.** The rules are typed and passed; server enforcement was not exercised.
- **Cost accuracy.** The budget uses `Session.Info.cost` and input plus output tokens. Provider accounting differences are not modeled.
- **Worktree isolation.** Designed, documented, not built.

## 12. Load it and smoke test it

1. Install dependencies once:

   ```sh
   cd /path/to/arena
   bun install
   ```

2. Add the plugin to a **project** config, not the global one, while testing:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/path/to/arena"]
   }
   ```

3. Restart OpenCode. `opencode --print-logs` if it does not appear; search the log for `arena`.

4. In a session, ask:

   ```text
   Use the arena tool. Objective: find why the archive import drops the last row.
   Success criteria: a test reproduces the drop and the fix makes it pass.
   Verification: bun test. Contestants: 2. Rounds: 1. Max cost: 0.5 USD.
   ```

5. Watch for: child sessions named `arena <run> C1 ...`, progress lines `round 1 explore` and `round 1 judge`, a judge session, and a final summary with a winner or an explicit rejection. Then check `runs/index` in plugin storage through a second run or the storage API.

If the tool does not appear, the usual causes are: the config uses `plugin` instead of `plugins`, the path points at a file rather than a directory, or `node_modules` is missing `@opencode/plugin`.

## 13. If you productionize it

Ordered by value per unit of work:

1. **Run it live on a small real task.** Fix the first three mismatches reality finds. Nothing below matters until this passes.
2. **Worktree mode.** Create one worktree per competitor, point the session location at it, have the judge read diffs. This turns proposals into applied patches and is the largest capability jump.
3. **A run viewer.** A TUI command or a small command that lists `runs/index` and prints a stored transcript. Debugging a multi-agent run without a transcript is guesswork.
4. **A global deadline and concurrency cap.** Today the timeouts are per session. A wall clock budget and a cap on simultaneous sessions make cost predictable on a weak machine or a rate limited provider.
5. **An evaluation harness.** The honest question is not "does the arena work" but "does the arena beat one strong agent at equal cost". Run both on the same twenty problems, compare accepted solutions, cost, and wall clock. Without that number, the arena is a hypothesis with good manners.

## Appendix: exact API surface used

```ts
// sessions
ctx.session.create({ parentID, title, agent, model, permissions, metadata }) => SessionInfo
ctx.session.prompt({ sessionID, text }) => SessionInboxUser
ctx.session.wait({ sessionID }, { signal }) => void
ctx.session.context({ sessionID }) => SessionMessageInfo[]
ctx.session.get({ sessionID }) => SessionInfo       // cost, tokens, outcome
ctx.session.interrupt({ sessionID, resume }) => { interrupted }
ctx.session.remove({ sessionID }) => void
ctx.session.instructions.entry.put({ sessionID, key, value }) => void

// plugin surface
ctx.tool.transform((editor) => editor.add({ name, description, input, execute, options })) => Registration
ctx.storage.set(key, json) / get(key) / scan({ prefix })
ctx.event.subscribe({ types, signal }) => AsyncIterable<Event>

// types that matter
SessionInfo: { id, parentID?, agent?, model?, cost, tokens, outcome?, location, time, title? }
SessionMessage.Assistant.content: Array<{ type: "text", text } | { type: "reasoning" } | { type: "tool" }>
ToolContext: { sessionID, agent, messageID, id, signal, progress }
```

Reference docs used: `opencode.ai/docs/build/plugins/server`, `opencode.ai/docs/plugins`, `opencode.ai/docs/agents`, and the OpenAPI document at `opencode.ai/docs/openapi.json`, all against CLI 2.2.7 and `@opencode/plugin` 2.2.7.
