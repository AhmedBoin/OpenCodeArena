import { describe, expect, test } from "bun:test"
import { ArenaRoom } from "../src/room.ts"
import { emptyView, relevance } from "../src/core/knowledge.ts"

describe("field bus routing", () => {
  test("routes a peer dead end to the queue for everyone", () => {
    const room = new ArenaRoom("p")
    room.addParticipant({ label: "Ada", role: "agent" })
    room.addParticipant({ label: "Hypatia", role: "agent" })
    const message = room.post({ author: "Ada", authorRole: "agent", kind: "dead-end", text: "no go", to: "all" })
    expect(room.route(message, room.participant("Hypatia")!)).toBe("queue")
  })

  test("routes a request to the addressee only", () => {
    const room = new ArenaRoom("p")
    room.addParticipant({ label: "Ada", role: "agent" })
    room.addParticipant({ label: "Hypatia", role: "agent" })
    const message = room.post({ author: "Ada", authorRole: "agent", kind: "request", text: "check n=3", to: ["Hypatia"] })
    expect(room.route(message, room.participant("Hypatia")!)).toBe("queue")
    const bystander = { ...room.participant("Hypatia")!, label: "Turing" }
    expect(room.route(message, bystander)).toBe("ignore")
  })

  test("routes an order to steer", () => {
    const room = new ArenaRoom("p")
    room.addParticipant({ label: "Ada", role: "agent" })
    const message = room.post({ author: "User", authorRole: "user", kind: "order", text: "stop", to: "all", order: true })
    expect(room.route(message, room.participant("Ada")!)).toBe("steer")
  })

  test("ranks a claim above a finding and below an order", () => {
    const view = emptyView()
    const claim = relevance({ id: "m1", author: "Ada", kind: "claim", text: "x", at: 1, to: "all" }, view, "Hypatia")
    const deadEnd = relevance({ id: "m2", author: "Ada", kind: "dead-end", text: "y", at: 1, to: "all" }, view, "Hypatia")
    const finding = relevance({ id: "m3", author: "Ada", kind: "finding", text: "z", at: 1, to: "all" }, view, "Hypatia")
    const order = relevance({ id: "m4", author: "User", kind: "order", text: "w", at: 1, to: "all" }, view, "Hypatia")
    expect(claim).toBeGreaterThan(deadEnd)
    expect(deadEnd).toBeGreaterThan(finding)
    expect(order).toBeGreaterThan(claim)
  })
})
