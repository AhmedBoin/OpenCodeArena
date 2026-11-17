import { describe, expect, test } from "bun:test"
import {
  dedupe,
  digest,
  dropItem,
  emptyView,
  keepItem,
  markSeen,
  relevance,
  visibleTo,
  type KnowledgeItem,
} from "../../src/core/knowledge.ts"

function item(id: string, kind: KnowledgeItem["kind"], text: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return { id, author: "C1", kind, text, at: 1_000, to: "all", ...extra }
}

describe("arena knowledge", () => {
  test("an ordered message outranks a finding and a chat", () => {
    const view = emptyView()
    const order = item("m1", "order", "focus on the retry race", { author: "User" })
    const finding = item("m2", "finding", "the retry path shares a key")
    const chat = item("m3", "chat", "hello team")
    expect(relevance(order, view, "C2")).toBeGreaterThan(relevance(finding, view, "C2"))
    expect(relevance(finding, view, "C2")).toBeGreaterThan(relevance(chat, view, "C2"))
  })

  test("my own messages never come back to me", () => {
    const view = emptyView()
    const mine = item("m1", "finding", "I found it", { author: "C2" })
    expect(visibleTo(mine, view, "C2")).toBe(false)
    expect(visibleTo(mine, view, "C1")).toBe(true)
  })

  test("dropped items are hidden and kept items survive", () => {
    const base = item("m1", "finding", "irrelevant noise")
    let view = dropItem(emptyView(), "m1")
    expect(visibleTo(base, view, "C2")).toBe(false)
    view = keepItem(view, "m1")
    expect(visibleTo(base, view, "C2")).toBe(true)
  })

  test("a private message stays private", () => {
    const secret = item("m1", "chat", "just for C2", { to: ["C2"], private: true })
    expect(visibleTo(secret, emptyView(), "C2")).toBe(true)
    expect(visibleTo(secret, emptyView(), "C1")).toBe(false)
  })

  test("duplicate text collapses to one item", () => {
    const items = [
      item("m1", "finding", "the retry path shares a key", { at: 1_000 }),
      item("m2", "finding", "The retry path   shares a key", { at: 2_000 }),
      item("m3", "finding", "unrelated"),
    ]
    const unique = dedupe(items)
    expect(unique).toHaveLength(2)
    expect(unique.map((entry) => entry.id)).toContain("m2")
    expect(unique.map((entry) => entry.id)).not.toContain("m1")
  })

  test("a directed question outranks a broadcast finding", () => {
    const question = item("m1", "question", "what is the event id?", { to: ["C2"] })
    const broadcast = item("m2", "finding", "I found a log line")
    expect(relevance(question, emptyView(), "C2")).toBeGreaterThan(relevance(broadcast, emptyView(), "C2"))
  })

  test("the digest respects the character budget and drops noise first", () => {
    const view = emptyView()
    const items = [
      item("m1", "order", "focus on the retry race", { author: "User" }),
      item("m2", "finding", "x".repeat(400)),
      item("m3", "chat", "y".repeat(400)),
      item("m4", "chat", "z".repeat(400)),
    ]
    const out = digest(items, view, "C2", { budget: 220, maxItems: 10 })
    expect(out).toContain("focus on the retry race")
    expect(out.length).toBeLessThanOrEqual(220)
  })

  test("seen ids are tracked without changing visibility", () => {
    const view = markSeen(emptyView(), ["m1", "m2"])
    expect(view.seen).toEqual(["m1", "m2"])
    expect(visibleTo(item("m1", "finding", "x"), view, "C2")).toBe(true)
  })
})
