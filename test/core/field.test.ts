import { describe, expect, test } from "bun:test"
import {
  acceptField,
  canTakeTurn,
  deadlineReached,
  finishField,
  markWrapped,
  memberOf,
  memberQuietFor,
  noteClaim,
  notePost,
  noteTurn,
  openField,
  rejectClaim,
  setMember,
} from "../../src/core/field.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Prove the boundary case of the recurrence",
  constraints: ["no guessing"],
  successCriteria: ["the case is settled with evidence"],
  nonGoals: [],
}

function base() {
  return openField({
    id: "f1",
    parentSessionID: "p",
    contract,
    members: [
      { label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" },
      { label: "Hypatia", agent: "plan", stance: STANCES[1]!, sessionID: "s2" },
    ],
    now: 1_000,
    budgetMs: 60_000,
    checkEveryMs: 180_000,
    maxTurns: 2,
    maxForemanTurns: 8,
  })
}

describe("field state", () => {
  test("starts every member idle with a shared deadline", () => {
    const state = base()
    expect(state.members.map((member) => member.status)).toEqual(["idle", "idle"])
    expect(state.members.map((member) => member.turns)).toEqual([0, 0])
    expect(state.deadlineAt).toBe(61_000)
    expect(state.status).toBe("running")
  })

  test("counts a turn and marks the member working", () => {
    const state = noteTurn(base(), "Ada", 2_000)
    expect(memberOf(state, "Ada")?.turns).toBe(1)
    expect(memberOf(state, "Ada")?.status).toBe("working")
    expect(memberOf(state, "Ada")?.lastTurnAt).toBe(2_000)
  })

  test("only an idle member takes a turn; the old maxTurns fuse no longer caps", () => {
    const done = noteTurn(noteTurn(base(), "Ada", 2_000), "Ada", 3_000)
    expect(canTakeTurn(done, "Ada")).toBe(false)
    expect(canTakeTurn(setMember(markWrapped(done, "Ada"), "Ada", "idle"), "Ada")).toBe(true)
  })

  test("a step fuse of zero means no per-agent cap", () => {
    const state = openField({
      id: "f2",
      parentSessionID: "p",
      contract,
      members: [{ label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" }],
      now: 1_000,
      budgetMs: 60_000,
      checkEveryMs: 180_000,
      maxTurns: 0,
      maxForemanTurns: 4,
    })
    let next = state
    for (let index = 0; index < 50; index++) next = noteTurn(next, "Ada", 2_000 + index)
    next = setMember(next, "Ada", "idle")
    expect(canTakeTurn(next, "Ada")).toBe(true)
  })

  test("notes posts, dead ends and a notebook line", () => {
    const state = notePost(base(), "Ada", "dead-end", 2_500, "induction fails at the boundary")
    expect(state.posts).toBe(1)
    expect(state.deadEnds).toBe(1)
    expect(memberOf(state, "Ada")?.notebook).toContain("dead-end")
    expect(memberOf(state, "Ada")?.notebook).toContain("induction fails")
    expect(memberOf(state, "Ada")?.lastPostAt).toBe(2_500)
  })

  test("a claim is recorded with evidence and attempts advance on rejection", () => {
    const state = noteClaim(base(), { label: "Ada", text: "done", evidence: ["bun test"], now: 2_000 })
    expect(state.claims[0]).toMatchObject({ label: "Ada", attempts: 0 })
    expect(state.claims[0]?.evidence).toEqual(["bun test"])
    expect(rejectClaim(state, "Ada").claims[0]?.attempts).toBe(1)
  })

  test("deadline and acceptance close the field once", () => {
    expect(deadlineReached(base(), 60_999)).toBe(false)
    expect(deadlineReached(base(), 61_000)).toBe(true)
    const accepted = acceptField(base(), { label: "Ada", reason: "verified", evidence: "bun test", now: 62_000 })
    expect(accepted.status).toBe("done")
    expect(accepted.stopReason).toBe("accepted")
    expect(accepted.closed?.decision).toBe("accepted")
    expect(accepted.members.every((member) => member.status === "done")).toBe(true)
    expect(finishField(accepted, "deadline", "late", 63_000).closed?.decision).toBe("accepted")
    expect(finishField(accepted, "deadline", "late", 63_000).stopReason).toBe("accepted")
  })

  test("memberQuietFor measures from the last activity", () => {
    const state = notePost(base(), "Ada", "finding", 5_000)
    expect(memberQuietFor(state, "Ada", 9_000)).toBe(4_000)
  })

  test("helpers return a new state and never mutate the old one", () => {
    const state = base()
    noteTurn(state, "Ada", 2_000)
    notePost(state, "Ada", "finding", 2_100)
    expect(state.members[0]?.turns).toBe(0)
    expect(state.posts).toBe(0)
  })
})
