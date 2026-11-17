import { describe, expect, test } from "bun:test"
import { permissionRules } from "../src/bindings.ts"
import { makeHarness, contract } from "./helpers.ts"

const crew = [
  { name: "Ada", role: "Builder", brief: "ships the smallest working change" },
  { name: "Hypatia", role: "Analyst", brief: "maps the system before touching it" },
]

function until(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
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

async function field(harness = makeHarness(() => "{}")) {
  const started = await harness.service.startField(contract, { crew }, "parent")
  await until(() => harness.service.fields.get(started.runID)?.snapshot.members.every((member) => member.turns === 1) ?? false)
  const run = harness.service.fields.get(started.runID)!
  return { harness, started, run }
}

describe("ArenaService", () => {
  test("a restricted field helper cannot run shell or mutate the tree", () => {
    const rules = permissionRules(true, false, true)
    for (const action of [
      "bash",
      "shell",
      "write",
      "patch",
      "task",
      "subagent",
      "arena_bus",
      "arena_fs",
      "arena_git",
      "arena_exec",
      "arena_job",
      "arena_spawn",
      "browser",
    ]) {
      expect(rules.some((rule) => rule.action === action && rule.effect === "deny")).toBe(true)
    }
    expect(rules.some((rule) => rule.action === "edit" && rule.effect === "deny")).toBe(true)
  })

  test("status shows the board plus the last room messages", async () => {
    const { harness, started, run } = await field()
    const ada = run.snapshot.members[0]!
    await harness.service.busPost(ada.sessionID, "finding", "the parser drops the trailing token")
    const status = await harness.service.fieldStatus("parent")
    expect(status).toContain(started.runID)
    expect(status).toContain("the parser drops the trailing token")
  })

  test("a field exposes one stream: posts, reads and a report", async () => {
    const { harness, started, run } = await field()
    const ada = run.snapshot.members[0]!
    const hypatia = run.snapshot.members[1]!
    const posted = await harness.service.busPost(ada.sessionID, "finding", "the retry path shares the key")
    expect(posted).toContain("Posted")
    const read = await harness.service.busRead(hypatia.sessionID)
    expect(read).toContain("the retry path shares the key")
    expect(await harness.service.report(undefined, "parent")).toContain("field")
    expect(await harness.service.list()).toContain(started.runID)
  })

  test("update sends a task to one named agent", async () => {
    const { harness, run } = await field()
    const ada = run.snapshot.members[0]!
    const update = await harness.service.updateParticipant({
      parentSessionID: "parent",
      label: ada.label,
      task: "check the boundary case first",
    })
    expect(update).toContain("task sent")
    expect(harness.runtime.prompts.some((prompt) => prompt.text.includes("check the boundary case first"))).toBe(true)
    const room = await harness.service.roomSnapshot("parent")
    expect(room.messages.some((message) => message.text.includes("New task for Ada"))).toBe(true)
  })

  test("spawns a native subagent with the requested agent and refuses past the depth cap", async () => {
    const harness = makeHarness((input) => (input.phase === "helper" ? "the parser lives in src/parse.ts" : "{}"))
    harness.service.bindings.set("caller", { runID: "missing", label: "Ada", role: "contestant", depth: 0 })
    const result = await harness.service.spawnSubagent({ agent: "plan", prompt: "where is the parser?" }, "caller")
    expect(result.ok).toBe(true)
    expect(result.text).toContain("src/parse.ts")
    const child = harness.runtime.created[0]
    expect(child?.agent).toBe("plan")
    expect(child?.parentID).toBe("caller")
    expect(child?.metadata?.arenaDepth).toBe(1)

    harness.service.bindings.set("deep", { runID: "missing", label: "Ada", role: "contestant", depth: 3 })
    const refused = await harness.service.spawnSubagent({ agent: "plan", prompt: "deeper" }, "deep")
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("depth limit")
  })

  test("refuses a second field on the same session and reports a readable status", async () => {
    const { harness, started } = await field()
    await expect(harness.service.startField(contract, { crew }, "parent")).rejects.toThrow("active field")
    const status = await harness.service.status(started.runID)
    expect(status.text).toContain(started.runID)
    expect(status.text).toContain("field")
  })
})
