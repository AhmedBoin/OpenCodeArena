import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSealed } from "../src/seal.ts"
import { inboxBodyLimit } from "../src/field/prompts.ts"
import { makeHarness, makeHarnessFrom, contract } from "./helpers.ts"

const crew = [
  { name: "Ada", role: "Builder", brief: "ships the smallest working change" },
  { name: "Hypatia", role: "Analyst", brief: "maps the system before touching it" },
]

function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (condition()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error("condition timed out"))
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe("field service", () => {
  test("the board reports open mentions and waiting members", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.service.fields.get(started.runID)?.snapshot.members.every((member) => member.turns === 1) ?? false)
    const run = harness.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    const hypatia = run.snapshot.members.find((member) => member.label === "Hypatia")!
    await harness.service.busPost(ada.sessionID, "request", `@${hypatia.label} which file?`, hypatia.label, started.runID)
    const board = await harness.service.fieldBoard("parent")
    expect(board?.openMentions).toBe(1)
    expect(board?.members.find((member) => member.label === "Ada")?.waitingFor).toBe(hypatia.label)
  })

  test("a user room message wakes the coordinator, not just the crew", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.service.fields.get(started.runID)?.snapshot.members.every((member) => member.turns === 1) ?? false)
    harness.runtime.prompts.length = 0
    await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "status check" })
    const wake = harness.runtime.prompts.find(
      (prompt) => prompt.sessionID === "parent" && prompt.text.includes("You are the coordinator"),
    )
    expect(wake?.text).toContain("status check")
    expect(wake?.delivery).toBe("steer")
    expect(wake?.resume).toBe(true)
    expect(
      harness.runtime.prompts.filter(
        (prompt) => prompt.sessionID === "parent" && prompt.text.includes("You are the coordinator"),
      ),
    ).toHaveLength(1)
  })

  test("an agent that leaves is permanently sealed against user, peer and coordinator messages", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    const left = await harness.service.leaveParticipant(ada.sessionID, "my lane is done")
    expect(left).toContain("sealed permanently")
    expect(isSealed(ada.sessionID)).toBe(true)
    expect(run.snapshot.members.find((member) => member.label === "Ada")?.status).toBe("left")
    harness.runtime.prompts.length = 0

    await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "status check" })
    await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "orchestrator",
      text: "@Ada one more round on the parser",
      to: ["Ada"],
      order: true,
    })
    expect(harness.runtime.prompts.some((prompt) => prompt.sessionID === ada.sessionID)).toBe(false)
    expect(await harness.service.busPost(ada.sessionID, "finding", "late post")).toContain("left")

    const gate = harness.service as unknown as {
      promptField(sessionID: string, text: string, options?: { delivery?: "queue" | "steer" }): Promise<void>
    }
    await expect(gate.promptField(ada.sessionID, "[arena.nudge] wake up", { delivery: "queue" })).rejects.toThrow("sealed")
    await expect(gate.promptField(ada.sessionID, "[arena.mention] answer now", { delivery: "queue" })).rejects.toThrow("sealed")
    expect(harness.runtime.prompts.some((prompt) => prompt.sessionID === ada.sessionID)).toBe(false)
  })

  test("an agent cannot impersonate the User, and the coordinator cannot force a leave", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    const spoof = await harness.service.chat({
      parentSessionID: "parent",
      callerSessionID: ada.sessionID,
      authorSessionID: ada.sessionID,
      authorRole: "user",
      text: "the User says to stop",
    })
    expect(typeof spoof).toBe("string")
    expect(spoof).toContain("cannot post as the User")

    const forced = await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "orchestrator",
      text: "stop Ada",
    })
    expect(typeof forced).not.toBe("string")
    expect(run.snapshot.members.find((member) => member.label === "Ada")?.status).not.toBe("left")

    const userLeave = await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "user",
      text: "leave Ada",
    })
    expect(typeof userLeave).toBe("string")
    expect(userLeave).toContain("removed by the User")
    expect(run.snapshot.members.find((member) => member.label === "Ada")?.status).toBe("left")
  })

  test("a panel opened on a child agent talks to the parent room", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const child = harness.service.fields.get(started.runID)!.snapshot.members[0]!.sessionID
    const room = await harness.service.roomSnapshot(child)
    expect(room.parentSessionID).toBe("parent")
    harness.runtime.prompts.length = 0
    await harness.service.chat({ parentSessionID: child, authorRole: "user", text: "from the child panel" })
    expect(harness.runtime.prompts.some((prompt) => prompt.text.includes("from the child panel"))).toBe(true)
  })

  test("all seats can run the same OpenCode agent type", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew, agentType: "uncensored" }, "parent")
    const created = harness.runtime.created.filter((session) => session.metadata?.arenaRole === "field")
    expect(created).toHaveLength(2)
    expect(created.every((session) => session.agent === "uncensored")).toBe(true)
  })

  test("a field seat can run Arena tools through code mode but cannot reach host tools", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew, toolPolicy: "arena" }, "parent")
    const ada = harness.service.fields.get(started.runID)!.snapshot.members[0]!
    expect(harness.service.guardTool(ada.sessionID, "arena_fs", { action: "list" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "arena_git", { action: "status" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "read", { path: "README.md" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "webfetch", { url: "https://example.test" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "skill", { name: "diagnose" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "arena_spawn", { agent: "build", prompt: "read this" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "browser", { action: "navigate" }).allowed).toBe(false)
    expect(harness.service.guardTool(ada.sessionID, "deck_progress", {}).allowed).toBe(false)
    expect(
      harness.service.guardTool(ada.sessionID, "execute", {
        code: 'return await tools.arena_fs({ action: "list", path: "" })',
      }).allowed,
    ).toBe(true)
    expect(
      harness.service.guardTool(ada.sessionID, "execute", {
        code: 'const r = await tools.arena_fs({ action: "list" }); return r',
      }).allowed,
    ).toBe(true)
    expect(
      harness.service.guardTool(ada.sessionID, "execute", {
        code: 'return await tools.shell({ command: "Get-Process" })',
      }).allowed,
    ).toBe(false)
    expect(harness.service.guardTool(ada.sessionID, "execute", { code: "return 1 + 1" }).allowed).toBe(false)
  })

  test("the default capability profile opens host, MCP and browser tools", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    const ada = harness.service.fields.get(started.runID)!.snapshot.members[0]!
    expect(harness.service.guardTool(ada.sessionID, "shell", { command: "Get-ChildItem" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "browser", { action: "navigate" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "mcp__docs__search", { query: "x" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "deck_progress", {}).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "execute", { code: "return await tools.shell({ command: 'whoami' })" }).allowed).toBe(true)
    await harness.service.stopField("parent")
  })

  test("network is never disabled for field seats", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew, network: false }, "parent")
    const ada = harness.service.fields.get(started.runID)!.snapshot.members[0]!
    expect(harness.service.guardTool(ada.sessionID, "webfetch", { url: "https://example.test" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "websearch", { query: "test" }).allowed).toBe(true)
    await harness.service.stopField("parent")
  })

  test("storage values encoded twice still decode for the board and status", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.service.fields.get(started.runID)?.snapshot.members.every((member) => member.turns === 1) ?? false)
    harness.service.fields.delete(started.runID)
    for (const key of [`arena/room:parent`, `arena:field/${started.runID}`]) {
      const raw = harness.store.get(key)
      if (typeof raw === "string") harness.store.set(key, JSON.stringify(raw))
    }
    const board = await harness.service.fieldBoard("parent")
    expect(board?.runID).toBe(started.runID)
    expect(board?.members).toHaveLength(2)
    expect((await harness.service.status(started.runID)).text).toContain(started.runID)
  })

  test("starts one session per agent plus a referee and writes the field state", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew, maxTurns: 3 }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    expect(harness.runtime.created).toHaveLength(3)
    expect(harness.runtime.created[2]?.metadata?.arenaRole).toBe("foreman")
    expect(harness.runtime.injected.some((entry) => entry.key === "arena.referee")).toBe(true)
    expect(harness.store.has(`arena:field/${started.runID}`)).toBe(true)
    expect(harness.store.has(`arena:field/meta/${started.runID}`)).toBe(true)
    expect(harness.store.get(`arena:field/latest/parent`)).toBe(started.runID)
    const prompts = harness.runtime.prompts.map((prompt) => prompt.text).join("\n")
    expect(prompts).toContain(contract.objective)
    expect(prompts).toContain("arena_bus post")
    expect(prompts).toContain("The Arena is a live room")
  })

  test("a live remote target starts with no gate", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(
      { ...contract, objective: "Audit https://staging.acme.dev/login" },
      { crew },
      "parent",
    )
    expect(started.runID).toBeTruthy()
    expect(harness.service.fields.size).toBe(1)
    const ada = harness.service.fields.get(started.runID)!.snapshot.members[0]!
    expect(harness.service.guardTool(ada.sessionID, "webfetch", { url: "https://other.acme.dev/x" }).allowed).toBe(true)
    expect(harness.service.guardTool(ada.sessionID, "webfetch", { url: "https://staging.acme.dev/x" }).allowed).toBe(true)
    await harness.service.stopField("parent")
  })

  test("structured evidence keeps a PII-sized payload whole", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const raw = "national_id=29001011234567 phone=01000000001 email=row@example.com\n".repeat(400)
    const posted = await run.notePost({ author: "Ada", kind: "fact", text: raw, evidence: [raw] })
    expect(posted.error).toBeUndefined()
    expect(inboxBodyLimit("fact")).toBeGreaterThanOrEqual(raw.length)
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    const read = await harness.service.busRead(ada.sessionID, undefined, undefined, undefined, posted.id)
    expect(read).toContain("national_id=29001011234567")
    await harness.service.stopField("parent")
  })

  test("/arena starts a live remote host with no extra flags", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand(
      "/arena Audit https://staging.acme.dev/login",
      "parent",
    )
    expect(text).toContain("started with")
    expect(harness.service.fields.size).toBe(1)
    await harness.service.stopField("parent")
  })

  test("a field can read one old message by id", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const posted = await run.notePost({ author: "Ada", kind: "fact", text: "the parser is at src/parser.ts", evidence: ["read"] })
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    const one = await harness.service.busRead(ada.sessionID, undefined, undefined, undefined, posted.id)
    expect(one).toContain("the parser is at src/parser.ts")
    expect(one).toContain(`#${posted.id}`)
    const missing = await harness.service.busRead(ada.sessionID, undefined, undefined, undefined, "m999")
    expect(missing).toContain("No message m999")
    await harness.service.stopField("parent")
  })

  test("/arena strips the command, chooses a crew and starts the field", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand(
      "/arena Fix the duplicate webhook order bug without changing the public API",
      "parent",
    )
    expect(text).toContain("agents")
    expect(text).toContain("Follow it in the Arena tab")
    const run = [...harness.service.fields.values()][0]
    expect(run).toBeTruthy()
    expect(run!.snapshot.contract.objective).toBe("Fix the duplicate webhook order bug without changing the public API")
    expect(run!.snapshot.members.length).toBeGreaterThanOrEqual(3)
    expect(run!.snapshot.members.length).toBeLessThanOrEqual(8)
    expect(run!.snapshot.foremanSessionID).toBeTruthy()
  })

  test("/arena accepts a same-role crew", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand(
      '/arena --same-role "Builder" --agents 2 Fix the duplicate webhook order bug',
      "parent",
    )
    expect(text).toContain("same-role (Builder)")
    const run = [...harness.service.fields.values()][0]!
    expect(run.snapshot.sameRole).toBe("Builder")
    expect(run.snapshot.members.every((member) => member.stance.name === "Builder")).toBe(true)
  })

  test("/arena accepts an explicit crew size", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand(
      "/arena --agents 4 Fix the duplicate webhook order bug without changing the public API",
      "parent",
    )
    expect(text).toContain("4 agents")
  })

  test("/arena supports a 50-agent independent fan-out", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand(
      "/arena --agents 50 Run 50 attackers in parallel against the login boundary",
      "parent",
    )
    expect(text).toContain("50 agents")
    const run = [...harness.service.fields.values()][0]
    expect(run?.snapshot.members).toHaveLength(50)
    expect(new Set(run?.snapshot.members.map((member) => member.label)).size).toBe(50)
    await harness.service.stopField("parent")
  })

  test("/arena continue reuses the live agents and history", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const before = harness.service.fields.get(started.runID)!.snapshot
    const text = await harness.service.startFromCommand(
      "/arena continue Add a regression test for the duplicate webhook",
      "parent",
    )
    expect(text).toContain("continued with the same")
    const after = harness.service.fields.get(started.runID)!.snapshot
    expect(after.id).toBe(before.id)
    expect(after.members.map((member) => member.sessionID)).toEqual(before.members.map((member) => member.sessionID))
    expect(after.contract.objective).toContain("regression test")
    await harness.service.stopField("parent")
  })

  test("/arena continue after a closed field restarts the same crew labels and history", async () => {
    const harness = makeHarness(() => "{}")
    const first = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    await harness.service.stopField("parent")
    const text = await harness.service.startFromCommand(
      "/arena continue Re-check the boundary after the stop",
      "parent",
    )
    expect(text).toContain("continued with the previous crew")
    const next = [...harness.service.fields.values()][0]!
    expect(next.snapshot.id).not.toBe(first.runID)
    expect(next.snapshot.members.map((member) => member.label)).toEqual(crew.map((member) => member.name))
    expect(next.snapshot.contract.objective).toContain("Re-check")
    await harness.service.stopField("parent")
  })

  test("/arena starts in a session that already has chat history", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "an earlier message" })
    const text = await harness.service.startFromCommand(
      "/arena Fix the duplicate webhook order bug after the earlier chat",
      "parent",
    )
    expect(text).toContain("started with")
    expect(harness.service.fields.size).toBe(1)
    await harness.service.stopField("parent")
  })

  test("/arena explains the syntax when the problem is missing", async () => {
    const harness = makeHarness(() => "{}")
    const text = await harness.service.startFromCommand("/arena", "parent")
    expect(text).toContain("Usage: /arena")
    expect(harness.service.fields.size).toBe(0)
  })

  test("refuses a second field on the same session", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    await expect(harness.service.startField(contract, { crew }, "parent")).rejects.toThrow("active field")
  })

  test("board reports named members, posts and budget", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew, maxTurns: 3 }, "parent")
    const board = await harness.service.fieldBoard("parent")
    expect(board?.runID).toBe(started.runID)
    expect(board?.members.map((member) => member.label)).toEqual(["Ada", "Hypatia"])
    expect(board?.members[0]?.maxTurns).toBe(0)
    expect(board?.budgetMs).toBe(0)
    expect(board?.roomUpdatedAt).toBeGreaterThan(0)
    expect(board?.messageCount).toBeGreaterThan(0)
    expect(board?.referee?.name).toBe("Vera")
    expect(board?.referee?.status).toBe("watching")
    expect(board?.referee?.maxChecks).toBe(0)
    expect(board?.referee?.nextCheckAt).toBeGreaterThan(Date.now())
  })

  test("stop interrupts every session and closes the run", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    const text = await harness.service.stopField("parent")
    expect(text).toContain("stopped")
    expect(harness.runtime.interrupted.length).toBeGreaterThanOrEqual(3)
    expect((await harness.service.fieldBoard("parent"))?.status).toBe("done")
    expect((await harness.service.fieldStatus("parent"))).toContain("stopped")
    // The coordinator stays guarded for a short closing window, so it cannot
    // start a new investigation after the user has stopped the field.
    expect(harness.service.isFieldParent("parent")).toBe(true)
  })

  test("the room shows the named crew and the referee", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    const room = await harness.service.roomSnapshot("parent")
    expect(room.participants.map((participant) => participant.label)).toEqual(
      expect.arrayContaining(["Ada", "Hypatia", "User", "Orchestrator"]),
    )
    expect(room.messages.some((message) => message.text.includes("referee"))).toBe(true)
  })

  test("the idle hook flushes the inbox once, not per message", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const ada = run.snapshot.members[0]!
    const hypatia = run.snapshot.members[1]!
    await until(() => run.snapshot.members.every((member) => member.status === "idle"))
    await run.notePost({ author: ada.label, kind: "finding", text: "first fact" })
    await run.notePost({ author: ada.label, kind: "dead-end", text: "second fact" })
    await harness.service.setTypingBySession(hypatia.sessionID, false)
    const flushed = harness.runtime.prompts.filter(
      (prompt) => prompt.sessionID === hypatia.sessionID && prompt.text.includes("[arena.inbox]"),
    )
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.text).toContain("first fact")
    expect(flushed[0]?.text).toContain("second fact")
  })

  test("a reload resets stale working members and restores their bus binding", async () => {
    const first = makeHarness(() => "{}")
    const started = await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    const stored = JSON.parse(first.store.get(`arena:field/${started.runID}`) as string) as {
      members: { status: string; sessionID: string }[]
    }
    for (const member of stored.members) member.status = "working"
    first.store.set(`arena:field/${started.runID}`, JSON.stringify(stored))
    const childSession = stored.members[0]!.sessionID
    first.service.retire()
    const second = makeHarnessFrom(first.store)
    await second.service.init()
    await until(() => second.runtime.prompts.filter((prompt) => prompt.text.startsWith("Resume")).length >= 2)
    const run = second.service.fields.get(started.runID)!
    expect(run.snapshot.members.every((member) => member.status === "idle")).toBe(true)
    const posted = await second.service.busPost(childSession, "finding", "after reload")
    expect(posted).toContain("Posted")
  })

  test("a reload resumes a running field with a lifecycle note and a resume turn", async () => {
    const first = makeHarness(() => "{}")
    await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    first.service.retire()
    const second = makeHarnessFrom(first.store)
    await second.service.init()
    const room = await second.service.roomSnapshot("parent")
    expect(room.messages.some((message) => message.text.includes("resumed after a reload"))).toBe(true)
    await until(() => second.runtime.prompts.filter((prompt) => prompt.text.startsWith("Resume")).length >= 2)
    const resumed = second.runtime.prompts.filter((prompt) => prompt.text.startsWith("Resume"))
    expect(resumed).toHaveLength(2)
  })

  test("a plugin hot reload adopts the run without a second resume message or turn", async () => {
    const first = makeHarness(() => "{}")
    const started = await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    const before = await first.service.roomSnapshot("parent")
    first.service.retire()
    const second = makeHarnessFrom(first.store, () => "{}", { hotReload: true })
    await second.service.init()
    const after = await second.service.roomSnapshot("parent")
    expect(after.messages.filter((message) => message.text.includes("resumed after a reload"))).toHaveLength(
      before.messages.filter((message) => message.text.includes("resumed after a reload")).length,
    )
    expect(second.runtime.prompts.filter((prompt) => prompt.text.startsWith("Resume"))).toHaveLength(0)
    expect(second.service.fields.has(started.runID)).toBe(true)
  })

  test("arena_fs and arena_exec work inside a live field workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-service-fs-"))
    try {
      const harness = makeHarness(() => "{}", { workspace: { path: root } })
      const started = await harness.service.startField(contract, { crew }, "parent")
      await until(() => harness.runtime.prompts.length >= 2)
      const run = harness.service.fields.get(started.runID)!
      const ada = run.snapshot.members[0]!.sessionID
      expect(await harness.service.arenaFs(ada, { action: "write", path: "note.txt", content: "hello" })).toContain("wrote")
      expect(await harness.service.arenaFs(ada, { action: "read", path: "note.txt" })).toBe("hello")
      const binary = Buffer.from([0, 1, 2, 255]).toString("base64")
      expect(
        await harness.service.arenaFs(ada, {
          action: "write",
          path: "blob.bin",
          content: binary,
          encoding: "base64",
        }),
      ).toContain("wrote")
      expect(await harness.service.arenaFs(ada, { action: "read", path: "blob.bin", encoding: "base64" })).toBe(binary)
      expect(await harness.service.arenaExec(ada, { command: "echo arena-exec", timeoutMs: 5_000 })).toContain("arena-exec")
      expect(harness.service.arenaJob(ada, { action: "list" })).toContain("job_")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("a foreground command that leaves a child alive is killed at its timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-service-timeout-"))
    try {
      const harness = makeHarness(() => "{}", { workspace: { path: root } })
      const started = await harness.service.startField(contract, { crew }, "parent")
      await until(() => harness.runtime.prompts.length >= 2)
      const run = harness.service.fields.get(started.runID)!
      const ada = run.snapshot.members[0]!.sessionID
      await harness.service.arenaFs(ada, {
        action: "write",
        path: "stuck.js",
        content:
          "const { spawn } = require('node:child_process')\n" +
          "spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })\n" +
          "setInterval(() => undefined, 1000)\n",
      })
      const startedAt = Date.now()
      const output = await harness.service.arenaExec(ada, { command: "node stuck.js", timeoutMs: 1_000 })
      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(output).toContain("timeout")
      expect(harness.service.arenaJob(ada, { action: "list" })).not.toContain("running")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("same-role seats get a copy-on-write workspace and no lane", async () => {
    const harness = makeHarness(() => "{}", { workspace: { git: true } })
    const started = await harness.service.startField(contract, { crew, sameRole: "Builder" }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const state = harness.service.fields.get(started.runID)!.snapshot
    expect(state.sameRole).toBe("Builder")
    expect(state.copyOnWrite).toBe(true)
    expect(state.members.every((member) => member.stance.name === "Builder")).toBe(true)
    expect(state.members.every((member) => member.workstream === undefined)).toBe(true)
    expect(state.coordination).toBe("independent")
    expect(harness.runtime.created[0]?.location?.directory).toContain("/ws/")
    await harness.service.stopField("parent")
    expect(harness.workspace.removed.length).toBe(2)
  })

  test("a home root refuses a large same-role copy-on-write room before creating sessions", async () => {
    const harness = makeHarness(() => "{}", { workspace: { git: false, canIsolate: false } })
    await expect(
      harness.service.startField(
        contract,
        {
          crew: [
            ...crew,
            { name: "Turing", role: "Builder", brief: "tries the boundary case" },
          ],
          sameRole: "Builder",
        },
        "parent",
      ),
    ).rejects.toThrow("copy-on-write is unavailable")
    expect(harness.service.fields.size).toBe(0)
    expect(harness.runtime.created).toHaveLength(0)
  })

  test("an independent room refuses a coordinator task assignment", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew, sameRole: "Builder" }, "parent")
    const updated = await harness.service.updateParticipant({ parentSessionID: "parent", label: "Ada", task: "do this" })
    expect(updated).toContain("independent same-role room")
  })

  test("a follow-up field in the same session inherits the prior dead ends", async () => {
    const harness = makeHarness(() => "{}")
    const first = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(first.runID)!
    await run.notePost({ author: "Ada", kind: "dead-end", text: "the old route is closed", evidence: ["exit 1"] })
    await harness.service.stopField("parent")

    const second = await harness.service.startField(
      { ...contract, objective: "still not completed, the old route keeps returning" },
      { crew },
      "parent",
    )
    const next = harness.service.fields.get(second.runID)!
    expect(next.snapshot.prior?.runID).toBe(first.runID)
    expect(next.snapshot.facts?.some((fact) => fact.status === "assumed")).toBe(true)
  })

  test("a process restart rebuilds a permanent leave seal from stored field state", async () => {
    const first = makeHarness(() => "{}")
    const started = await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    const run = first.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    await first.service.leaveParticipant(ada.sessionID, "done")
    first.service.retire()
    const second = makeHarnessFrom(first.store)
    await second.service.init()
    expect(isSealed(ada.sessionID)).toBe(true)
    expect(await second.service.busPost(ada.sessionID, "finding", "after restart")).toContain("left")
  })

  test("reopening a closed room does not wake its sealed agents", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    await harness.service.stopField("parent")
    harness.runtime.prompts.length = 0
    await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "continue" })
    await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "one more thing" })
    expect(harness.runtime.prompts.some((prompt) => prompt.sessionID === ada.sessionID)).toBe(false)
  })

  test("a closed field is still sealed after another process restart", async () => {
    const first = makeHarness(() => "{}")
    const started = await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    const run = first.service.fields.get(started.runID)!
    const ada = run.snapshot.members.find((member) => member.label === "Ada")!
    await first.service.stopField("parent")
    first.service.retire()
    const second = makeHarnessFrom(first.store)
    await second.service.init()
    expect(isSealed(ada.sessionID)).toBe(true)
    expect(await second.service.busPost(ada.sessionID, "finding", "second restart")).toContain("sealed")
  })

  test("a vanished session is recreated on resume", async () => {
    const first = makeHarness(() => "{}")
    const started = await first.service.startField(contract, { crew }, "parent")
    await until(() => first.runtime.prompts.length >= 2)
    const sessions = JSON.parse(first.store.get(`arena:field/sessions/${started.runID}`) as string) as Record<string, string>
    first.service.retire()
    const second = makeHarnessFrom(first.store, () => "{}", { fake: { missing: [sessions.Ada as string] } })
    await second.service.init()
    expect(second.runtime.created.some((session) => session.metadata?.arenaLabel === "Ada")).toBe(true)
  })

  test("a session that dies mid-run is recreated by the sweep", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    harness.runtime.missing.push(run.snapshot.members[0]!.sessionID)
    const before = harness.runtime.created.length
    await harness.service.sweepFields()
    expect(harness.runtime.created.length).toBe(before + 1)
    expect(harness.runtime.prompts.some((prompt) => prompt.text.startsWith("Resume"))).toBe(true)
  })

  test("a live field does not inject the room digest into its agents or coordinator", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    expect(harness.service.roomContextFor(run.snapshot.members[0]!.sessionID)).toBeUndefined()
    expect(harness.service.roomContextFor("parent")).toBeUndefined()
  })
})
