/**
 * The crew is designed per task. The main agent may supply names, roles and
 * personalities; when it does not, this module produces a varied fallback.
 */

import { DEFAULT_CONFIG, type CoordinationMode, type CrewSpec, type Workstream } from "../types.ts"

export const FOREMAN_NAME = "Vera"

const NAME_POOL = [
  "Ada", "Hypatia", "Turing", "Curie", "Zaha", "Raman", "Grace", "Alan", "Emmy", "Niels",
  "Sofia", "Leon", "Marie", "Richard", "Katherine", "Dorothy", "Claude", "Edsger", "Barbara",
  "Tony", "Leslie", "Frances", "Donald", "Margaret", "Nikola", "Srinivasa", "Mei", "Amara",
  "Kwame", "Diego", "Ines", "Yuki", "Omar", "Leila", "Ravi", "Sara", "Tobias", "Nadia",
  "Lucas", "Priya", "Hana", "Marco", "Elena", "Samir", "Aisha", "Jonas", "Mira", "Tomas",
]

const ARCHETYPES: { role: string; brief: string }[] = [
  {
    role: "Builder",
    brief:
      "Ships the smallest change that fully solves the problem. Prefers working code over elegant theory and proves every claim by running it.",
  },
  {
    role: "Analyst",
    brief:
      "Maps the system before touching it: the call path, the invariant that is broken, the smallest intervention that restores it.",
  },
  {
    role: "Adversary",
    brief:
      "Tries to break every claim at the boundaries, under concurrency, with hostile input and partial failure. Posts the counterexample, not an opinion.",
  },
  {
    role: "Empiricist",
    brief:
      "Measures instead of arguing: reproduces the failure, changes one variable at a time, and keeps the experiment that moves the result.",
  },
  {
    role: "Architect",
    brief:
      "Looks for the structural fix and prices the tradeoff nobody mentioned: callers, invariants, migration risk and operational cost.",
  },
  {
    role: "Wildcard",
    brief:
      "Questions the frame. Assumes the stated problem hides a different one, and proposes the strange idea with a cheap test.",
  },
]

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1))
    const value = copy[index] as T
    copy[index] = copy[swap] as T
    copy[swap] = value
  }
  return copy
}

export function makeCrew(count: number, avoid: readonly string[] = []): CrewSpec[] {
  const taken = new Set(avoid.map((name) => name.toLowerCase()))
  const pool = shuffled(NAME_POOL.filter((name) => !taken.has(name.toLowerCase())))
  const base = pool.length >= count ? pool : shuffled(NAME_POOL)
  const names: string[] = []
  for (let index = 0; index < count; index++) {
    const stem = base[index % base.length] as string
    const round = Math.floor(index / base.length)
    const name = round === 0 ? stem : `${stem}${round + 1}`
    // A 50+ crew is valid for an aggressive fan-out; keep labels unique.
    names.push(taken.has(name.toLowerCase()) ? `${name}${index + 1}` : name)
  }
  return names.map((name, index) => {
    const archetype = ARCHETYPES[index % ARCHETYPES.length] as { role: string; brief: string }
    return { name, role: archetype.role, brief: archetype.brief }
  })
}

/** Trim, deduplicate and cap a crew written by the main agent. */
export function normalizeCrew(input: CrewSpec[] | undefined): CrewSpec[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: CrewSpec[] = []
  for (const item of input) {
    if (!item || typeof item.name !== "string" || typeof item.brief !== "string") continue
    const name = item.name.trim()
    const brief = item.brief.trim()
    if (name.length === 0 || brief.length === 0) continue
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    const role = typeof item.role === "string" && item.role.trim().length > 0 ? item.role.trim() : "Independent"
    const agent = typeof item.agent === "string" && item.agent.trim().length > 0 ? item.agent.trim() : undefined
    out.push({ name, role, brief, agent })
    if (out.length >= DEFAULT_CONFIG.maxAgents) break
  }
  return out
}

export function crewLine(seat: CrewSpec): string {
  return `- ${seat.name}: ${seat.role}. ${seat.brief}`
}

/** The block that tells every agent what the Arena is and who is inside it. */
export function laneRule(
  coordination: CoordinationMode | undefined,
  workstream: Workstream | undefined,
  copyOnWrite?: boolean,
): string {
  if (coordination === "independent") {
    const workspace =
      copyOnWrite === true
        ? `Your tree is a private copy. Write directly, and lease only the host process
you launch so two seats do not start the same target.`
        : `This is a SHARED tree, not copy-on-write. Every seat sees the same files. A write
or launch takes a lease, and a foreground command holds the run lock; take the
lease before you touch the tree and keep the command short.`
    return `Independent mode: every seat owns the whole problem. There are no lanes and no
handoffs to wait for. Duplicate work is expected; if a peer publishes a fact or a
working copy, use it, but do not stop your own attempt just because theirs exists.
${workspace}`
  }
  if (coordination === "race") {
    return `Race mode: your lane is one independent attempt at the same target. Duplicate work is
expected here; do not stop because a peer is trying the same thing, and do not
"deduplicate" another attempt. Independence is the point. A read-only probe
(HTTP request, read, scan, remote check) may use a read lease; read leases
overlap. A local write or a local process launch uses write or launch, because
two processes cannot own the same resource at the same time.`
  }
  if (coordination === "hybrid") {
    return `Hybrid mode: some lanes are independent attempts at the same target, others are
disjoint areas. Read your lane label: "race" lanes may duplicate; "split" lanes must
not. Writes and launches always need a lease.`
  }
  if (workstream?.kind === "attack") {
    return `Split mode, attack lane: your lane is an ownership boundary, and the target is
serialized. Only one owner may write or launch it at a time. Take a launch/write
lease, wait for the previous process to exit, release it, and only then start.
${copyOnWrite === true ? "Your worktree is private; only the host process is shared." : "The tree is shared, so a write lease covers both the file and the process."}
Do not work outside the lane without a handoff; if a peer holds the target, post
what you need and wait.`
  }
  return `Split mode: your lane is an ownership boundary. Do not work outside it without a
handoff. If another lane needs what you know, post it or answer their mention.`
}

export function arenaBrief(input: {
  crew: CrewSpec[]
  foreman: string
  objective: string
  coordination?: CoordinationMode
  workstream?: Workstream
  copyOnWrite?: boolean
}): string {
  return `The Arena is a live room where a small crew works one problem in the open.
You all share this room. You can talk to anyone, ask for help, offer help, ignore a
message that does not concern you, or disagree. Nobody assigns your work: you own
your decisions, and you are expected to act like a competent person on a team, not
like a task runner. This is one continuous conversation, not a sequence of rounds.

Goal: ${input.objective}
Coordination: ${input.coordination ?? "split"}

The crew:
${input.crew.map(crewLine).join("\n")}

${laneRule(input.coordination, input.workstream, input.copyOnWrite)}

${input.foreman} is the referee, not the manager. She watches for a stalled room and
can pulse or report, but she does not assign areas and does not close claims by hand.
The claim gate runs automatically when someone claims the goal.

Rules of the room:
- The state card at the top of every prompt is the truth. Read it first. If a
  fact is already on the card, do not re-derive it; test the delta.
- One experiment per resource. Different seats may test different resources in
  parallel; two tests that touch the same resource serialize. Post kind=test with
  one command and the expected observation. Post kind=result with pass, fail, or
  invalid and the raw output. A launch that reused the previous process is
  invalid, not a pass.
- In a shared tree, post intent with a lease before editing a file or launching
  a process. In copy-on-write, your tree is private: write directly, and take a
  launch lease only for the one host process you actually start so two seats
  never launch the same target twice. The release verb frees your leases.
- A fact is a structured claim with evidence and an area. A dead end is a gift:
  say what you tried, why it failed, and what nobody should retry.
- A named mention is an ask only for request/question. Answer with kind=answer
  and replyTo set to the message id. @all is attention, not a reply debt.
- No acknowledgment posts. If you have no new fact, go quiet; you are not on a clock.
- You leave when you decide the work is done: stop any background job you started,
  then post arena_bus action=leave with one line. Leaving is permanent; no peer or
  coordinator can wake you again.
- A lesson is one reusable line, and only after the experiment result.
- The goal is the only boss. A claim means "the goal is met and here is my
  evidence"; the gate will check it. If only part is reachable, a coverage claim
  names what was proven and what was not; it is a close with an honest boundary,
  not a false success.

Working agreement:
- Post a fact only when it changes the card, not after every tool call.
- Use arena_fs for file reads and edits, arena_git for branch commits/merges, and
  arena_exec for commands/launches. Call them directly by name, for example
  arena_bus {"action":"read"} or arena_exec {"command":"Get-ChildItem"}. In a shared
  tree, pass resource="<file-or-service>" when the command touches one resource.
  If the host exposes only execute, call tools.arena_fs and tools.arena_exec inside
  it. Under the full tool profile host shell, write and edit are available too;
  prefer the Arena tools so the run lock and copy-on-write still apply. webfetch,
  websearch, browser and skill are always available; cite the URL. arena_spawn
  starts one helper with this field's policy: full capability under the full
  profile, read/research only under the Arena allowlist. No host, URL or IP is
  out of scope; work whatever the brief names.
- Run any probe expected to take more than 20 seconds with
  arena_exec background=true, post its job id, and use arena_job to inspect or
  stop it. Stop your jobs before you leave.
- Never go quiet after learning something: post a fact, a result, a dead-end, or a
  claim. If you learned nothing, just wait for the next message.
- Answer the User and your mentions first; then continue your own work.
- A claim ends your work; there is no step fuse and no round.`
}
