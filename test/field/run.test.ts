import { describe, expect, test } from "bun:test"
import { openField } from "../../src/core/field.ts"
import { boardOf, FieldRun, type FieldDeps, type FieldPost } from "../../src/field/run.ts"
import { resetSeals } from "../../src/seal.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Prove the boundary case of the recurrence",
  constraints: ["no guessing"],
  successCriteria: ["the case is settled with evidence"],
  nonGoals: [],
  verificationCommand: "bun test",
}

function harness(
  input: Partial<FieldDeps> & {
    maxTurns?: number
    maxForemanTurns?: number
    budgetMs?: number
    copyOnWrite?: boolean
    workspaceRoot?: string
    sameRole?: string
  } = {},
) {
  resetSeals()
  const { maxTurns, maxForemanTurns, budgetMs, copyOnWrite, workspaceRoot, sameRole, ...overrides } = input
  let now = 1_000
  const prompts: { sessionID: string; text: string; delivery?: string; files?: { name?: string }[] }[] = []
  const posts: FieldPost[] = []
  const deps: FieldDeps = {
    now: () => now,
    parentSessionID: "p",
    prompt: async (sessionID, text, options) => {
      prompts.push({ sessionID, text, delivery: options?.delivery, files: options?.files })
    },
    wait: async () => "idle",
    info: async () => ({ outcome: "succeeded" }),
    finalText: async () => '{"falsified":false,"reason":"ok"}',
    usage: async () => ({ costUSD: 0, tokens: 5 }),
    interrupt: async () => undefined,
    verify: async () => ({ ok: true, output: "pass" }),
    post: async (post) => {
      posts.push(post)
      return { id: `m${posts.length}` }
    },
    save: async () => undefined,
    flushDelayMs: 5,
    coordinatorDigestMs: 20_000,
    quietMs: 100,
    turnTimeoutMs: 1_000,
    verifyTimeoutMs: 1_000,
    foremanTimeoutMs: 1_000,
    mentionTimeoutMs: 60_000,
    intentLeaseMs: 600_000,
    cancelled: () => false,
    ...overrides,
  }
  const state = openField({
    id: "f1",
    parentSessionID: "p",
    contract,
    foremanSessionID: "vera",
    members: [
      {
        label: "Ada",
        agent: "build",
        stance: STANCES[0]!,
        sessionID: "s1",
        workspacePath: copyOnWrite ? "C:\\own\\Ada" : undefined,
        workspaceIsolated: copyOnWrite,
      },
      {
        label: "Hypatia",
        agent: "plan",
        stance: STANCES[1]!,
        sessionID: "s2",
        workspacePath: copyOnWrite ? "C:\\own\\Hypatia" : undefined,
        workspaceIsolated: copyOnWrite,
      },
    ],
    workspaceRoot,
    copyOnWrite,
    sameRole,
    now,
    budgetMs: budgetMs ?? 600_000,
    checkEveryMs: 180_000,
    maxTurns: maxTurns ?? 30,
    maxForemanTurns: maxForemanTurns ?? 8,
  })
  return {
    run: new FieldRun(deps, state),
    prompts,
    posts,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("field run", () => {
  test("start sends one kickoff turn per member, with the Arena briefing", async () => {
    const { run, prompts } = harness()
    await run.start()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.text).toContain("The Arena is a live room")
    expect(prompts[0]?.text).toContain("You are Ada")
    expect(prompts[0]?.text).toContain("Vera")
    expect(prompts[0]?.text).toContain("arena_bus post")
    expect(run.snapshot.members.every((member) => member.turns === 1 && member.status === "idle")).toBe(true)
  })

  test("a foreground job stuck past the stall window is killed and released", async () => {
    let job: { id: string; startedAt: number; foreground?: boolean } | undefined = {
      id: "job_stuck",
      startedAt: 1_000,
      foreground: true,
    }
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const stopped: string[] = []
    const { run, advance, posts } = harness({
      wait: async () => {
        await blocked
        return "idle"
      },
      info: async () => ({ outcome: undefined }),
      jobFor: () => job,
      stopJob: async (id) => {
        stopped.push(id)
        job = undefined
      },
      stallAfterMs: 60_000,
    })
    const started = run.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    advance(61_000)
    await run.tick()
    expect(stopped).toEqual(["job_stuck"])
    expect(posts.some((post) => post.text.includes("was stuck in job_stuck"))).toBe(true)
    expect(run.snapshot.members.find((member) => member.label === "Ada")?.status).toBe("idle")
    release?.()
    await started
  })

  test("a model turn with no host activity is interrupted after the stall window", async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { run, advance, posts } = harness({
      wait: async () => {
        await blocked
        return "idle"
      },
      info: async () => ({ outcome: undefined, updatedAt: 1_000 }),
      stallAfterMs: 1_000,
    })
    const started = run.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    advance(5_000)
    await run.tick()
    expect(posts.some((post) => post.text.includes("no host activity"))).toBe(true)
    expect(run.snapshot.members.find((member) => member.label === "Ada")?.status).toBe("idle")
    release?.()
    await started
  })

  test("an idle room checks Vera on the interval, not on every tick", async () => {
    const { run, advance, prompts } = harness()
    await run.start()
    prompts.length = 0
    for (let index = 0; index < 5; index++) {
      advance(10_000)
      await run.tick()
    }
    expect(prompts.filter((prompt) => prompt.sessionID === "vera")).toHaveLength(0)
    advance(150_000)
    await run.tick()
    expect(prompts.some((prompt) => prompt.sessionID === "vera")).toBe(true)
  })

  test("a field with no new evidence asks every seat for a final report", async () => {
    const { run, advance, prompts } = harness({ maxNoProgressMinutes: 1 })
    await run.start()
    prompts.length = 0
    advance(120_000)
    await run.tick()
    expect(prompts.filter((prompt) => prompt.text.includes("[arena.converge]")).length).toBeGreaterThanOrEqual(2)
  })

  test("the delivery ledger records queued and delivered messages", async () => {
    const { run, advance } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "finding", text: "the parser is in src/parser.ts" })
    advance(20)
    await run.tick()
    const ledger = run.snapshot.deliveries ?? []
    expect(ledger.length).toBeGreaterThan(0)
    expect(ledger.some((entry) => entry.deliveredAt !== undefined)).toBe(true)
    const board = boardOf(run.snapshot, 2_000)
    expect(board.delivery?.delivered).toBeGreaterThan(0)
    expect(board.delivery?.queued).toBeGreaterThanOrEqual(board.delivery?.delivered ?? 0)
  })

  test("a peer finding waits for the idle window and arrives as one batch", async () => {
    const { run, prompts, advance } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "finding", text: "the bug is in retry" })
    expect(prompts).toHaveLength(0)
    advance(10)
    await run.tick()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionID).toBe("s2")
    expect(prompts[0]?.text).toContain("[arena.inbox]")
    expect(prompts[0]?.text).toContain("the bug is in retry")
  })

  test("an order steers immediately", async () => {
    const { run, prompts } = harness()
    await run.start()
    prompts.length = 0
    await run.publish({
      id: "m9",
      author: "User",
      authorRole: "user",
      kind: "order",
      text: "focus the parser",
      to: "all",
      order: true,
      private: false,
      mentions: [],
      at: 1,
      roomID: "r",
      round: 1,
    })
    expect(prompts).toHaveLength(3)
    expect(prompts.filter((prompt) => prompt.sessionID !== "p")).toHaveLength(2)
    expect(prompts[0]?.delivery).toBe("steer")
    expect(prompts[0]?.text).toContain("focus the parser")
    const coordinator = prompts.find((prompt) => prompt.sessionID === "p")
    expect(coordinator?.delivery).toBe("steer")
    expect(coordinator?.text).toContain("focus the parser")
  })

  test("a targeted post is broadcast and marked as a mention", async () => {
    const { run, prompts } = harness()
    await run.start()
    prompts.length = 0
    await run.publish({
      id: "m10",
      author: "User",
      authorRole: "user",
      kind: "chat",
      text: "check the boundary case",
      to: ["Hypatia"],
      order: false,
      private: false,
      mentions: [],
      at: 1,
      roomID: "r",
      round: 1,
    })
    expect(prompts).toHaveLength(3)
    const ada = prompts.find((prompt) => prompt.sessionID === "s1")
    const hypatia = prompts.find((prompt) => prompt.sessionID === "s2")
    expect(ada?.text).toContain("check the boundary case")
    expect(ada?.text).not.toContain("MENTION")
    expect(hypatia?.text).toContain("MENTION")
    expect(run.snapshot.mentions ?? []).toHaveLength(0)
  })

  test("a named mention wakes an idle peer immediately and holds the asker", async () => {
    const { run, prompts, advance } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "request", text: "@Hypatia which file owns the parser?" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompts.some((prompt) => prompt.sessionID === "s2" && prompt.text.includes("MENTION"))).toBe(true)
    advance(1_000)
    prompts.length = 0
    await run.tick()
    expect(prompts.some((prompt) => prompt.sessionID === "s1")).toBe(false)
  })

  test("a peer finding is steered into a working agent before its turn ends", async () => {
    const { run, prompts } = harness()
    await run.start()
    await run.noteTurnStart("s2")
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "finding", text: "the parser lives in src/parser.ts" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const delivered = prompts.find((prompt) => prompt.sessionID === "s2")
    expect(delivered?.delivery).toBe("steer")
    expect(delivered?.text).toContain("src/parser.ts")
  })

  test("an answer releases the asker with the answer in its inbox", async () => {
    const { run, prompts, posts } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "request", text: "@Hypatia which file owns the parser?" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    prompts.length = 0
    await run.notePost({ author: "Hypatia", kind: "answer", text: "src/parser.ts", replyTo: "m1" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompts.some((prompt) => prompt.sessionID === "s1" && prompt.text.includes("src/parser.ts"))).toBe(true)
    expect(posts.some((post) => post.replyTo === "m1")).toBe(true)
  })

  test("a third party cannot close someone else's mention", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "request", text: "@Hypatia which file?" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ask = run.snapshot.mentions?.[0]
    expect(ask?.status).toBe("open")
    await run.notePost({ author: "Omar", kind: "answer", text: "not mine", replyTo: ask?.id })
    expect(run.snapshot.mentions?.[0]?.status).toBe("open")
    expect(run.snapshot.mentions?.[0]?.answeredBy).toBeUndefined()
  })

  test("an unanswered mention expires and the asker continues", async () => {
    const { run, prompts, advance } = harness({ mentionTimeoutMs: 60_000 })
    await run.start()
    await run.notePost({ author: "Ada", kind: "request", text: "@Hypatia which file?" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    advance(61_000)
    prompts.length = 0
    await run.tick()
    expect(prompts.some((prompt) => prompt.sessionID === "s1" && prompt.text.includes("did not answer"))).toBe(true)
    expect(run.snapshot.mentions?.[0]?.status).toBe("expired")
  })

  test("@all wakes everyone but creates no reply debt", async () => {
    const { run, prompts, advance } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "note", text: "@all the parser fixture is reset" })
    advance(10)
    await run.tick()
    expect(prompts.filter((prompt) => prompt.text.includes("@all")).length).toBeGreaterThan(0)
    expect(run.snapshot.mentions ?? []).toHaveLength(0)
  })

  test("an intent creates a public lease and an overlap warns both owners", async () => {
    const { run, posts } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "parser", text: "taking parser for 10m", leaseMinutes: 10 })
    await run.notePost({ author: "Hypatia", kind: "intent", area: "parser", text: "I need parser too", leaseMinutes: 10 })
    expect(run.snapshot.intents?.filter((intent) => intent.status === "active")).toHaveLength(1)
    expect(
      posts.some(
        (post) =>
          post.text.includes("Lease refused") &&
          post.text.includes("Ada") &&
          post.text.includes("Hypatia"),
      ),
    ).toBe(true)
  })

  test("contradicting facts open one arbitration", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({
      author: "Ada",
      kind: "fact",
      area: "reader",
      text: "the bytes are 75 07",
      evidence: ["dump"],
    })
    await run.notePost({
      author: "Hypatia",
      kind: "fact",
      area: "reader",
      text: "the bytes are 48 8B EC",
      evidence: ["read"],
      contradicts: ["m1"],
    })
    const arbitration = run.snapshot.arbitrations?.find((entry) => entry.status === "open")
    expect(arbitration).toBeDefined()
    expect(arbitration?.factIDs).toContain("m1")
    expect(arbitration?.factIDs).toContain("m2")
    expect(arbitration?.test.length).toBeGreaterThan(0)
  })

  test("a fenced write is blocked for another owner", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "parser", text: "taking parser", leaseKind: "write" })
    const denied = run.guardTool("s2", "write", { path: "parser" })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain("Ada")
  })

  test("copy-on-write refuses a write to the shared baseline but allows the member's copy", async () => {
    const { run } = harness({ copyOnWrite: true, workspaceRoot: "C:\\shared" })
    await run.start()
    const shared = run.guardTool("s1", "write", { path: "C:\\shared\\src\\app.ts" })
    const own = run.guardTool("s1", "write", { path: "C:\\own\\Ada\\src\\app.ts" })
    expect(shared.allowed).toBe(false)
    expect(shared.reason).toContain("copy-on-write")
    expect(own.allowed).toBe(true)
  })

  test("a handoff releases an area and a lesson is kept", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "parser", text: "taking parser" })
    await run.notePost({ author: "Ada", kind: "handoff", area: "parser", text: "parser is free" })
    expect(run.snapshot.intents?.[0]?.status).toBe("released")
    await run.notePost({ author: "Ada", kind: "lesson", text: "reset the fixture before the parser test" })
    expect(run.snapshot.lessons?.[0]?.text).toContain("reset the fixture")
  })

  test("a quiet member stays in the room instead of being forced out by a step fuse", async () => {
    const { run, advance } = harness({ maxTurns: 1 })
    await run.start()
    advance(10)
    await run.tick()
    expect(run.snapshot.members.every((member) => member.status === "idle")).toBe(true)
    expect(run.snapshot.members.every((member) => member.status !== "left")).toBe(true)
  })

  test("the field ends only when every agent has left", async () => {
    const { run } = harness()
    await run.start()
    await run.leave({ label: "Ada", by: "self", reason: "lane closed" })
    expect(run.snapshot.status).toBe("running")
    await run.leave({ label: "Hypatia", by: "self", reason: "lane closed" })
    expect(run.snapshot.status).toBe("done")
    expect(run.snapshot.stopReason).toBe("all-left")
    expect(run.snapshot.report?.outcome).toBeDefined()
  })

  test("a working owner's lease is renewed instead of expiring under it", async () => {
    const { run, advance } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "parser", text: "taking parser", leaseMinutes: 1 })
    await run.noteTurnStart("s1")
    advance(9 * 60_000)
    await run.tick()
    expect(run.snapshot.intents?.[0]?.status).toBe("active")
    expect(run.snapshot.intents?.[0]?.expiresAt).toBeGreaterThan(run.snapshot.startedAt + 9 * 60_000)
  })

  test("a running experiment can be handed to a new owner", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({
      author: "Ada",
      kind: "oracle",
      text: "the log says OK",
      evidence: ["baseline: log says NONE"],
      oracleKind: "file",
    })
    await run.notePost({
      author: "Ada",
      kind: "test",
      text: "the parser reads the new level",
      command: "run parser",
      expect: "level 300",
    })
    await run.notePost({
      author: "Ada",
      kind: "handoff",
      experiment: "e1",
      to: ["Hypatia"],
      text: "Hypatia takes the parser run",
    })
    const result = await run.notePost({
      author: "Hypatia",
      kind: "result",
      experiment: "e1",
      result: "fail",
      observed: "level 1",
      text: "the parser still reads 1",
    })
    expect(result.error).toBeUndefined()
    const experiment = run.snapshot.experiments?.find((entry) => entry.id === "e1")
    expect(experiment?.owner).toBe("Hypatia")
    expect(experiment?.status).toBe("fail")
  })

  test("tick stops the field at the deadline", async () => {
    const { run, advance } = harness()
    await run.start()
    advance(600_000)
    await run.tick()
    expect(run.snapshot.stopReason).toBe("deadline")
    expect(run.snapshot.status).toBe("done")
  })

  test("attach replaces a lost session and injects the notebook", async () => {
    const { run, prompts } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "dead-end", text: "induction fails at the boundary" })
    await run.attach("Ada", "s9")
    expect(run.snapshot.members[0]?.sessionID).toBe("s9")
    expect(prompts.at(-1)?.text).toContain("induction fails at the boundary")
  })

  test("the context hook does not count a turn", async () => {
    const { run } = harness()
    await run.start()
    expect(run.snapshot.members[0]?.turns).toBe(1)
    await run.noteTurnStart("s1")
    expect(run.snapshot.members[0]?.turns).toBe(1)
    expect(run.snapshot.members[0]?.status).toBe("working")
  })

  test("leave returns before it interrupts its own tool call", async () => {
    const interrupted: string[] = []
    const { run } = harness({ interrupt: async (sessionID) => { interrupted.push(sessionID) } })
    await run.start()
    const left = await run.leave({ label: "Ada", by: "self", reason: "done" })
    expect(left.ok).toBe(true)
    expect(interrupted).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(interrupted).toContain("s1")
  })

  test("a same-role room refuses an order but accepts a plain chat", async () => {
    const { run } = harness({ sameRole: "Builder" })
    await run.start()
    const base = {
      id: "d1",
      author: "Orchestrator",
      authorRole: "orchestrator" as const,
      kind: "directive" as const,
      text: "@Ada one action",
      to: ["Ada"] as string[],
      private: false,
      mentions: ["Ada"],
      at: 1,
      roomID: "r",
      round: 1,
    }
    const ordered = await run.publish({ ...base, order: true })
    expect(ordered.ok).toBe(false)
    expect(ordered.error).toContain("independent same-role")
    const chat = await run.publish({ ...base, id: "d2", order: false })
    expect(chat.ok).toBe(true)
  })

  test("only the agent can leave, and a left agent can never be woken again", async () => {
    const { run, prompts } = harness()
    await run.start()
    const left = await run.leave({ label: "Ada", by: "self", reason: "my lane is finished" })
    expect(left.ok).toBe(true)
    expect(run.snapshot.members[0]?.status).toBe("left")
    expect(run.snapshot.members[0]?.leftBy).toBe("self")
    prompts.length = 0
    await run.publish({
      id: "m20",
      author: "User",
      authorRole: "user",
      kind: "chat",
      text: "@Ada come back",
      to: ["Ada"],
      order: false,
      private: false,
      mentions: ["Ada"],
      at: 1,
      roomID: "r",
      round: 1,
    })
    await run.publish({
      id: "m21",
      author: "Orchestrator",
      authorRole: "orchestrator",
      kind: "order",
      text: "@Ada take another pass",
      to: ["Ada"],
      order: true,
      private: false,
      mentions: ["Ada"],
      at: 2,
      roomID: "r",
      round: 1,
    })
    expect(prompts.some((prompt) => prompt.sessionID === "s1")).toBe(false)
    expect((await run.notePost({ author: "Ada", kind: "finding", text: "late" })).error).toContain("left")
  })

  test("resume resets stale working members and starts their turns again", async () => {
    const { run, prompts } = harness()
    await run.start()
    await run.noteTurnStart("s1")
    expect(run.snapshot.members[0]?.status).toBe("working")
    prompts.length = 0
    await run.resume()
    expect(run.snapshot.members.every((member) => member.status === "idle")).toBe(true)
    expect(prompts.filter((prompt) => prompt.text.startsWith("Resume"))).toHaveLength(2)
  })

  test("a stopped run does not start new turns", async () => {
    const { run, prompts } = harness()
    await run.start()
    await run.stop("stopped", "the user stopped it")
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "finding", text: "late" })
    await run.tick()
    expect(run.snapshot.status).toBe("done")
    expect(run.snapshot.stopReason).toBe("stopped")
    expect(prompts).toHaveLength(0)
  })

  test("a coverage claim closes accepted when the full verification cannot pass", async () => {
    const { run } = harness({ verify: async () => ({ ok: false, output: "the remote half failed" }) })
    await run.start()
    await run.notePost({
      author: "Ada",
      kind: "claim",
      text: "the local boundary is proven; the remote half is not reachable",
      evidence: ["bun test -> 12 pass"],
      coverage: ["local boundary proven", "remote half not reachable"],
    })
    expect(run.snapshot.status).toBe("done")
    expect(run.snapshot.stopReason).toBe("accepted")
    expect(run.snapshot.closed?.decision).toBe("accepted")
  })

  test("a claim runs verification and closes accepted", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "claim", text: "goal met", evidence: ["bun test -> 0 fail"] })
    expect(run.snapshot.status).toBe("done")
    expect(run.snapshot.stopReason).toBe("accepted")
    expect(run.snapshot.closed?.decision).toBe("accepted")
  })

  test("same-role facts and findings reach every seat", async () => {
    const { run, prompts, advance } = harness({ sameRole: "Builder" })
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "fact", text: "the parser is at src/parser.ts", evidence: ["read"] })
    await run.notePost({ author: "Ada", kind: "finding", text: "the sky is blue" })
    advance(20)
    await run.tick()
    expect(prompts.some((prompt) => prompt.sessionID === "s2" && prompt.text.includes("src/parser.ts"))).toBe(true)
    expect(prompts.some((prompt) => prompt.sessionID === "s2" && prompt.text.includes("sky is blue"))).toBe(true)
  })

  test("a same-role seat gets a card delta after its first full card", async () => {
    const { run, prompts, advance } = harness({ sameRole: "Builder" })
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "fact", text: "the parser is at src/parser.ts", evidence: ["read"] })
    advance(20)
    await run.tick()
    const wake = prompts.find((prompt) => prompt.sessionID === "s2")
    expect(wake?.text).toContain("ARENA")
    expect(wake?.text).not.toContain("GOAL")
  })

  test("a same-role coordinator gets a coalesced digest instead of one wake per fact", async () => {
    const { run, prompts, advance } = harness({ sameRole: "Builder" })
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "fact", text: "the parser is at src/parser.ts", evidence: ["read"] })
    advance(10_000)
    await run.tick()
    expect(prompts.some((prompt) => prompt.sessionID === "p")).toBe(false)

    await run.notePost({ author: "Ada", kind: "dead-end", text: "the registry route is closed", evidence: ["exit 1"] })
    advance(11_000)
    await run.tick()
    const wake = prompts.find((prompt) => prompt.sessionID === "p")
    expect(wake?.text).toContain("src/parser.ts")
    expect(wake?.text).toContain("registry route")
  })

  test("in a same-role room an accepted solution is shared without closing the field", async () => {
    const { run, posts } = harness({ sameRole: "Builder" })
    await run.start()
    await run.notePost({ author: "Ada", kind: "claim", text: "the fix is in the copy", evidence: ["bun test -> 0 fail"] })
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.claims[0]?.accepted).toBe(true)
    expect(posts.some((post) => post.text.includes("Solution accepted from Ada"))).toBe(true)
  })

  test("a rejected claim sends the claimer back to work", async () => {
    const { run, prompts } = harness({ verify: async () => ({ ok: false, output: "2 fail" }) })
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "claim", text: "goal met", evidence: ["guess"] })
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.claims[0]?.attempts).toBe(1)
    expect(prompts.some((prompt) => prompt.text.includes("rejected"))).toBe(true)
  })

  test("the referee can recommend a close but cannot force one", async () => {
    const { run, posts, advance } = harness({
      quietMs: 1_000_000,
      finalText: async (sessionID) => (sessionID === "vera" ? '{"action":"abort","reason":"stuck"}' : '{"falsified":false}'),
    })
    await run.start()
    advance(180_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.stopReason).toBeUndefined()
    expect(posts.some((post) => post.text.includes("Vera recommends a close"))).toBe(true)
  })

  test("the referee can pulse a quiet room", async () => {
    const { run, prompts, posts, advance } = harness({
      quietMs: 1_000_000,
      finalText: async (sessionID) =>
        sessionID === "vera" ? '{"action":"pulse","reason":"no posts"}' : '{"falsified":false}',
    })
    await run.start()
    advance(180_000)
    await run.tick()
    expect(posts.some((post) => post.text.includes("Room is quiet"))).toBe(true)
    // Vera may ask the room, but she does not wake idle agents.
    expect(prompts.some((prompt) => prompt.sessionID !== "p" && prompt.text.includes("arena.pulse"))).toBe(false)
    expect(prompts.some((prompt) => prompt.sessionID === "p" && prompt.text.includes("Room is quiet"))).toBe(true)
  })

  test("the referee cannot close a claim by hand", async () => {
    const { run, advance } = harness({
      quietMs: 1_000_000,
      verify: async () => ({ ok: false, output: "2 fail" }),
      finalText: async (sessionID) =>
        sessionID === "vera" ? '{"action":"close","claim":"Ada","reason":"looks done"}' : '{"falsified":false}',
    })
    await run.start()
    await run.notePost({ author: "Ada", kind: "claim", text: "goal met", evidence: ["guess"] })
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.claims[0]?.attempts).toBe(1)
    advance(180_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.claims[0]?.attempts).toBe(1)
  })

  test("an open mention prevents the all-idle abort", async () => {
    const { run, advance } = harness({ quietMs: 1_000_000 })
    await run.start()
    await run.notePost({ author: "Ada", kind: "request", text: "@Hypatia which file?" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    advance(1_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.mentions?.[0]?.status).toBe("open")
  })

  test("Vera cannot abort while an agent is still working", async () => {
    const { run, advance } = harness({
      quietMs: 1_000_000,
      info: async () => ({ outcome: undefined }),
      finalText: async (sessionID) =>
        sessionID === "vera" ? '{"action":"abort","reason":"quiet"}' : '{"falsified":false}',
    })
    await run.start()
    await run.noteTurnStart("s1")
    advance(180_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.stopReason).toBeUndefined()
  })

  test("a report recommendation does not close the field", async () => {
    const { run, posts, advance } = harness({
      quietMs: 1_000_000,
      finalText: async (sessionID) =>
        sessionID === "vera" ? '{"action":"report","reason":"the remaining route is untested"}' : '{"falsified":false}',
    })
    await run.start()
    advance(180_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
    expect(run.snapshot.stopReason).toBeUndefined()
    expect(posts.some((post) => post.text.includes("remaining route is untested"))).toBe(true)
  })

  test("an unreadable referee answer defaults to continue", async () => {
    const { run, advance } = harness({ quietMs: 1_000_000, finalText: async () => "prose" })
    await run.start()
    advance(180_000)
    await run.tick()
    expect(run.snapshot.status).toBe("running")
  })

  test("peer activity reaches the coordinator in one digest", async () => {
    const { run, prompts, advance } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "finding", text: "the parser lives in src/parser.ts" })
    await run.notePost({ author: "Hypatia", kind: "dead-end", text: "the old retry path is empty" })
    advance(21_000)
    await run.tick()
    const digests = prompts.filter((prompt) => prompt.sessionID === "p" && prompt.text.includes("[arena.coordinator]"))
    expect(digests).toHaveLength(1)
    expect(digests[0]?.delivery).toBe("steer")
    expect(digests[0]?.text).toContain("src/parser.ts")
    expect(digests[0]?.text).toContain("old retry path")
    expect(digests[0]?.text).toContain("Do not poll")
  })

  test("a user attachment reaches the coordinator prompt as a file", async () => {
    const { run, prompts } = harness()
    await run.start()
    prompts.length = 0
    await run.publish({
      id: "m22",
      author: "User",
      authorRole: "user",
      kind: "chat",
      text: "read this screenshot",
      to: "all",
      order: false,
      private: false,
      mentions: [],
      at: 1,
      roomID: "r",
      round: 1,
      meta: { attachments: [{ name: "shot.png", mime: "image/png", data: "AAAA" }] },
    })
    const coordinator = prompts.find((prompt) => prompt.sessionID === "p")
    expect(coordinator?.text).toContain("read this screenshot")
    expect(coordinator?.files?.[0]?.name).toBe("shot.png")
  })

  test("an idle agent stays reachable by the User and the coordinator", async () => {
    const { run, prompts } = harness()
    await run.start()
    prompts.length = 0
    await run.publish({
      id: "m20",
      author: "User",
      authorRole: "user",
      kind: "chat",
      text: "one more check please",
      to: "all",
      order: false,
      private: false,
      mentions: [],
      at: 1,
      roomID: "r",
      round: 1,
    })
    expect(prompts.some((prompt) => prompt.sessionID === "s1")).toBe(true)
    expect(prompts.some((prompt) => prompt.sessionID === "p" && prompt.text.includes("one more check please"))).toBe(true)
  })

  test("the referee keeps checking when the cap is disabled", async () => {
    const { run, advance } = harness({
      maxForemanTurns: 0,
      budgetMs: 5_000_000,
      quietMs: 1_000_000,
      finalText: async (sessionID) => (sessionID === "vera" ? '{"action":"continue"}' : "{}"),
    })
    await run.start()
    for (let index = 0; index < 9; index++) {
      advance(180_000)
      await run.tick()
    }
    expect(run.snapshot.foremanTurns).toBe(9)
    expect(run.snapshot.lastRefereeDecision).toBe("continue")
    expect(run.board().referee?.status).toBe("watching")
    expect(run.board().referee?.maxChecks).toBe(0)
  })

  test("a read-only command is not a launch, but Start-Process is", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "Acrobat", text: "taking the launch", leaseKind: "launch" })
    expect(run.guardTool("s2", "shell", { command: "Get-Process Acrobat | Select Id,StartTime" }).allowed).toBe(true)
    expect(run.guardTool("s2", "shell", { command: "Get-ChildItem 'C:\\Program Files\\Adobe\\Acrobat DC'" }).allowed).toBe(true)
    const blocked = run.guardTool("s2", "shell", { command: "Start-Process Acrobat.exe" })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toContain("Ada")
    const direct = run.guardTool("s2", "arena_exec", { command: "Start-Process Acrobat.exe" })
    expect(direct.allowed).toBe(false)
    expect(direct.reason).toContain("Ada")
    const script = run.guardTool("s2", "arena_exec", {
      command: "powershell -NoProfile -ExecutionPolicy Bypass -File artifacts\\oracle.ps1",
    })
    expect(script.allowed).toBe(false)
  })

  test("a launch lease carries the job and PID and is released by that job only", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "target", text: "launching", leaseKind: "launch" })
    await run.attachLaunch("Ada", "job_1", 1234)
    let lease = run.snapshot.intents?.find((intent) => intent.owner === "Ada" && intent.kind === "launch")
    expect(lease?.jobID).toBe("job_1")
    expect(lease?.pid).toBe(1234)
    await run.releaseLaunch("Ada", "job_2")
    lease = run.snapshot.intents?.find((intent) => intent.owner === "Ada" && intent.kind === "launch")
    expect(lease?.status).toBe("active")
    await run.releaseLaunch("Ada", "job_1")
    lease = run.snapshot.intents?.find((intent) => intent.owner === "Ada" && intent.kind === "launch")
    expect(lease?.status).toBe("released")
  })

  test("a handoff releases every lease the owner holds", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({ author: "Ada", kind: "intent", area: "parser", text: "taking parser" })
    await run.notePost({ author: "Ada", kind: "intent", area: "lexer", text: "taking lexer" })
    await run.notePost({ author: "Ada", kind: "handoff", area: "unrelated", text: "released" })
    expect(run.snapshot.intents?.filter((intent) => intent.status === "active")).toHaveLength(0)
  })

  test("a duplicate fact returns the existing id and posts nothing", async () => {
    const { run, posts } = harness()
    await run.start()
    const claim = "the parser reader compares the level against one hundred"
    const first = await run.notePost({ author: "Ada", kind: "fact", area: "reader", text: claim, evidence: ["dump"] })
    const before = posts.length
    const second = await run.notePost({ author: "Hypatia", kind: "fact", area: "reader", text: claim, evidence: ["dump"] })
    expect(first.id).not.toBe("0")
    expect(second.id).toBe(first.id)
    expect(second.error).toContain("already on the board")
    expect(posts).toHaveLength(before)
  })

  test("an acknowledgment is stored but never delivered", async () => {
    const { run, prompts, advance } = harness()
    await run.start()
    prompts.length = 0
    await run.notePost({ author: "Ada", kind: "finding", text: "Accepted, I will take the parser next" })
    advance(10)
    await run.tick()
    expect(prompts.some((prompt) => prompt.text.includes("Accepted, I will take"))).toBe(false)
  })

  test("the coordinator order budget is a private error, not a room notice", async () => {
    const { run } = harness({ coordinatorMinIntervalMs: 0, maxCoordinatorOrders: 2 })
    await run.start()
    const directive = (id: string) => ({
      id,
      author: "Orchestrator",
      authorRole: "orchestrator" as const,
      kind: "directive" as const,
      text: "@Ada one action",
      to: ["Ada"],
      order: true,
      private: false,
      mentions: ["Ada"],
      at: 1,
      roomID: "r",
      round: 1,
    })
    expect((await run.publish(directive("d1"))).ok).toBe(true)
    expect((await run.publish(directive("d2"))).ok).toBe(true)
    const third = await run.publish(directive("d3"))
    expect(third.ok).toBe(false)
    expect(third.error).toContain("order budget spent")
    const chat = await run.publish({ ...directive("d4"), order: false, kind: "directive" })
    expect(chat.ok).toBe(true)
  })

  test("a structured post over the 64k limit is rejected, and a PII-sized finding is not cut", async () => {
    const { run, posts } = harness()
    await run.start()
    const tooLong = "x".repeat(65_000)
    const fact = await run.notePost({ author: "Ada", kind: "fact", text: tooLong, evidence: ["dump"] })
    expect(fact.id).toBe("0")
    expect(fact.error).toContain("too long")
    const finding = await run.notePost({ author: "Ada", kind: "finding", text: "y".repeat(60_000) })
    expect(finding.error).toBeUndefined()
    const posted = posts.at(-1)
    expect(posted?.text.length).toBe(60_000)
    expect(posted?.detail).toBeUndefined()
  })

  test("oracle, test and result are one checked experiment", async () => {
    const { run } = harness()
    await run.start()
    await run.notePost({
      author: "Ada",
      kind: "oracle",
      text: "the app log says LICENSE_TYPE_PRO after a clean start",
      evidence: ["capture baseline.log"],
      oracleKind: "command",
    })
    expect(run.snapshot.oracle?.confirmed).toBe(true)
    await run.notePost({
      author: "Ada",
      kind: "test",
      text: "level 100 is read at startup",
      command: "start acrobat",
      expect: "log says LICENSE_TYPE_PRO",
      killIf: "log says NONE",
      evidence: ["start acrobat"],
    })
    expect(run.snapshot.experiments?.[0]?.status).toBe("running")
    await run.notePost({
      author: "Ada",
      kind: "result",
      text: "log says NONE",
      experiment: "e1",
      result: "fail",
      observed: "LICENSE_TYPE_NONE",
      pidBefore: "100",
      pidAfter: "200",
    })
    expect(run.snapshot.experiments?.[0]?.status).toBe("fail")
    expect(run.snapshot.facts?.some((entry) => entry.status === "refuted")).toBe(true)
  })
})
