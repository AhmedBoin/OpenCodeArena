import { describe, expect, test } from "bun:test"
import { ArenaRoom } from "../src/room.ts"
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

describe("arena room", () => {
  test("typing clears when the agent posts and when it finishes", () => {
    const room = new ArenaRoom("parent")
    room.addParticipant({ label: "Ada", role: "agent" })
    room.setTyping("Ada", true)
    expect(room.participant("Ada")?.typing).toBe(true)
    room.post({ author: "Ada", authorRole: "agent", kind: "chat", text: "a reply" })
    expect(room.participant("Ada")?.typing).toBe(false)
    room.setTyping("Ada", true)
    room.setStatus("Ada", "done")
    expect(room.participant("Ada")?.typing).toBe(false)
  })

  test("creates a per-session room with the named crew and steers an order", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const result = await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "user",
      text: "Focus on the boundary case",
      order: true,
    })
    expect(typeof result).not.toBe("string")
    if (typeof result === "string") return
    expect(result.message.author).toBe("User")
    expect(result.message.order).toBe(true)
    expect(result.room.participants.some((participant) => participant.label === "Ada")).toBe(true)
    expect(result.room.participants.some((participant) => participant.label === "Orchestrator")).toBe(true)
    const steered = harness.runtime.prompts.filter((prompt) => prompt.text.includes("Focus on the boundary case"))
    expect(steered.length).toBeGreaterThanOrEqual(2)
    expect(steered[0]?.delivery).toBe("steer")
  })

  test("a goal message claims the goal and steers the room", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const result = await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "user",
      text: "goal: the answer is the boundary case at zero",
      to: "all",
      order: false,
    })
    expect(typeof result).not.toBe("string")
    if (typeof result === "string") return
    expect(result.room.goal?.text).toContain("boundary case at zero")
  })

  test("consume drops an id from that participant's digest", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const room = await harness.service.roomSnapshot("parent")
    const message = room.messages[room.messages.length - 1]!
    const text = await harness.service.consumeRoom({ parentSessionID: "parent", label: "Ada", ids: [message.id], keep: false })
    expect(text).toContain(message.id)
    const after = await harness.service.roomSnapshot("parent")
    expect(after.participants.find((participant) => participant.label === "Ada")?.drop).toContain(message.id)
  })

  test("an attachment reaches every agent and stays on the room message", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    harness.runtime.prompts.length = 0
    const result = await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "user",
      text: "look at this screenshot",
      attachments: [{ name: "shot.png", mime: "image/png", data: "aGVsbG8=" }],
    })
    expect(typeof result).not.toBe("string")
    const prompts = harness.runtime.prompts.filter((prompt) => prompt.text.includes("look at this screenshot"))
    expect(prompts).toHaveLength(3)
    const fieldPrompts = prompts.filter((prompt) => (prompt.files?.length ?? 0) > 0)
    expect(fieldPrompts).toHaveLength(3)
    expect(fieldPrompts.every((prompt) => prompt.files?.[0]?.name === "shot.png")).toBe(true)
    expect(prompts.some((prompt) => prompt.sessionID === "parent" && prompt.text.includes("coordinator"))).toBe(true)
    const room = await harness.service.roomSnapshot("parent")
    const message = room.messages.find((entry) => entry.text === "look at this screenshot")
    expect(message?.meta?.attachments?.[0]?.mime).toBe("image/png")
    expect(message?.to).toBe("all")
    expect(started.runID).toBeTruthy()
  })

  test("a message mentions one agent but reaches everyone", async () => {
    const harness = makeHarness(() => "{}")
    const started = await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const run = harness.service.fields.get(started.runID)!
    const [ada, hypatia] = run.snapshot.members
    harness.runtime.prompts.length = 0
    await harness.service.chat({
      parentSessionID: "parent",
      authorRole: "user",
      text: "only for Ada",
      to: ["ada"],
      private: true,
    })
    const adaPrompt = harness.runtime.prompts.find((prompt) => prompt.sessionID === ada!.sessionID)
    const hypatiaPrompt = harness.runtime.prompts.find((prompt) => prompt.sessionID === hypatia!.sessionID)
    expect(adaPrompt?.text).toContain("only for Ada")
    expect(adaPrompt?.text).toContain("MENTION")
    expect(hypatiaPrompt?.text).toContain("only for Ada")
    expect(hypatiaPrompt?.text).not.toContain("MENTION")
    const room = await harness.service.roomSnapshot("parent")
    const message = room.messages.find((entry) => entry.text === "only for Ada")
    expect(message?.to).toBe("all")
    expect(message?.private).toBe(false)
    expect(message?.mentions).toContain("Ada")
  })

  test("the stop command stops the field and closes the room", async () => {
    const harness = makeHarness(() => "{}")
    await harness.service.startField(contract, { crew }, "parent")
    await until(() => harness.runtime.prompts.length >= 2)
    const result = await harness.service.chat({ parentSessionID: "parent", authorRole: "user", text: "stop", order: true })
    expect(typeof result).not.toBe("string")
    const room = await harness.service.roomSnapshot("parent")
    expect(room.closed).toBe(true)
    expect((await harness.service.fieldBoard("parent"))?.status).toBe("done")
  })
})
