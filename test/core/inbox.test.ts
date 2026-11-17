import { describe, expect, test } from "bun:test"
import { INBOX_CAP, emptyInbox, enqueue, pending, shouldFlush, take, type InboxItem } from "../../src/core/inbox.ts"

const item = (id: string, at: number): InboxItem => ({ id, author: "Ada", kind: "finding", text: id, to: "all", at })

describe("field inbox", () => {
  test("keeps messages in post order", () => {
    const state = enqueue(enqueue(emptyInbox(), "Hypatia", item("m1", 1)), "Hypatia", item("m2", 2))
    expect(take(state, "Hypatia").items.map((entry) => entry.id)).toEqual(["m1", "m2"])
  })

  test("take empties the buffer", () => {
    const { state } = take(enqueue(emptyInbox(), "Hypatia", item("m1", 1)), "Hypatia")
    expect(pending(state, "Hypatia")).toBe(0)
  })

  test("drops the oldest past the cap", () => {
    let state = emptyInbox()
    for (let index = 0; index < INBOX_CAP + 3; index++) state = enqueue(state, "Hypatia", item(`m${index}`, index))
    const { items } = take(state, "Hypatia")
    expect(items).toHaveLength(INBOX_CAP)
    expect(items[0]?.id).toBe("m3")
    expect(items[items.length - 1]?.id).toBe(`m${INBOX_CAP + 2}`)
  })

  test("labels are independent", () => {
    const state = enqueue(emptyInbox(), "Hypatia", item("m1", 1))
    expect(pending(state, "Ada")).toBe(0)
    expect(pending(state, "Hypatia")).toBe(1)
  })

  test("flushes only when idle and the debounce elapsed", () => {
    expect(shouldFlush({ queued: 1, working: true, now: 9, lastActivityAt: 0, debounceMs: 5 })).toBe(false)
    expect(shouldFlush({ queued: 1, working: false, now: 9, lastActivityAt: 8, debounceMs: 5 })).toBe(false)
    expect(shouldFlush({ queued: 0, working: false, now: 9, lastActivityAt: 0, debounceMs: 5 })).toBe(false)
    expect(shouldFlush({ queued: 1, working: false, now: 9, lastActivityAt: 0, debounceMs: 5 })).toBe(true)
  })

  test("enqueue never mutates the previous state", () => {
    const before = emptyInbox()
    const after = enqueue(before, "Hypatia", item("m1", 1))
    expect(pending(before, "Hypatia")).toBe(0)
    expect(pending(after, "Hypatia")).toBe(1)
  })
})
