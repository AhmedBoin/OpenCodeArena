import { describe, expect, test } from "bun:test"
import {
  contestFact,
  markStale,
  openArbitration,
  proposeFact,
  resolveArbitration,
} from "../../src/core/blackboard.ts"
import { openField, type FieldState } from "../../src/core/field.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Settle the reader bytes",
  constraints: ["evidence first"],
  successCriteria: ["one decisive check"],
  nonGoals: [],
}

function field(): FieldState {
  return openField({
    id: "field-1",
    parentSessionID: "parent",
    contract,
    members: [
      { label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s-ada" },
      { label: "Curie", agent: "plan", stance: STANCES[1]!, sessionID: "s-curie" },
    ],
    now: 1_000,
    budgetMs: 60_000,
    checkEveryMs: 10_000,
    maxTurns: 10,
    maxForemanTurns: 4,
  })
}

function contested(): FieldState {
  let state = field()
  state = proposeFact(state, {
    id: "f1",
    author: "Ada",
    claim: "the reader returns bytes 75 07",
    evidence: ["dump at base+0x7dc0cf"],
    area: "reader",
    at: 1_000,
  })
  state = proposeFact(state, {
    id: "f2",
    author: "Ada",
    claim: "the reader returns bytes 48 8B EC",
    evidence: ["ReadProcessMemory at base+0x7dc0cf"],
    area: "reader",
    at: 1_001,
  })
  return contestFact(state, { id: "f2", by: "Ada", at: 1_002 })
}

describe("blackboard", () => {
  test("two opposite facts on one area produce one arbitration with a neutral owner", () => {
    const state = contested()
    const arbitrations = state.arbitrations ?? []

    expect(arbitrations).toHaveLength(1)
    expect(arbitrations[0]?.factIDs).toEqual(["f1", "f2"])
    expect(arbitrations[0]?.owner).toBe("Curie")
    expect(arbitrations[0]?.test).toContain("ReadProcessMemory")
    expect(arbitrations[0]?.deadlineAt).toBe(121_002)
    expect(arbitrations[0]?.status).toBe("open")
    expect(state.facts?.find((fact) => fact.id === "f2")?.status).toBe("contested")

    const again = openArbitration(state, { id: "f2", at: 2_000 })
    expect(again.arbitrations ?? []).toHaveLength(1)
  })

  test("resolving marks one fact verified and the other refuted", () => {
    let state = contested()
    const arbitration = state.arbitrations![0]!

    state = resolveArbitration(state, { id: arbitration.id, result: "f1: bytes are 75 07", at: 2_000 })

    expect(state.arbitrations?.[0]?.status).toBe("resolved")
    expect(state.arbitrations?.[0]?.result).toBe("f1: bytes are 75 07")
    expect(state.facts?.find((fact) => fact.id === "f1")?.status).toBe("verified")
    expect(state.facts?.find((fact) => fact.id === "f2")?.status).toBe("refuted")
  })

  test("a refuted fact makes a dependent fact superseded", () => {
    let state = contested()
    const arbitration = state.arbitrations![0]!
    state = resolveArbitration(state, { id: arbitration.id, result: "f1: bytes are 75 07", at: 2_000 })
    expect(state.facts?.find((fact) => fact.id === "f2")?.status).toBe("refuted")

    state = proposeFact(state, {
      id: "f3",
      author: "Curie",
      claim: "the retry path inherits the reader bytes",
      evidence: ["trace"],
      area: "retry",
      basedOn: ["f2"],
      at: 3_000,
    })
    state = {
      ...state,
      hypotheses: [
        {
          id: "h1",
          statement: "the retry path reuses f2",
          test: "re-run f2 and compare",
          killIf: "f2 is refuted",
          status: "open",
        },
        {
          id: "h2",
          statement: "already settled",
          test: "re-run f2",
          killIf: "never",
          status: "refuted",
        },
      ],
    }

    state = markStale(state, "f2")

    expect(state.facts?.find((fact) => fact.id === "f3")?.status).toBe("superseded")
    expect(state.hypotheses?.find((hypothesis) => hypothesis.id === "h1")?.status).toBe("stale")
    expect(state.hypotheses?.find((hypothesis) => hypothesis.id === "h2")?.status).toBe("refuted")
  })

  test("an explicit contradiction contests both facts and opens nothing yet", () => {
    let state = field()
    state = proposeFact(state, {
      id: "f1",
      author: "Ada",
      claim: "the disk is clean",
      evidence: ["scan"],
      area: "disk",
      status: "verified",
      at: 1_000,
    })
    state = proposeFact(state, {
      id: "f2",
      author: "Curie",
      claim: "the disk has a bad sector",
      evidence: ["scan"],
      area: "disk",
      contradicts: ["f1"],
      at: 2_000,
    })

    expect(state.facts?.find((fact) => fact.id === "f1")?.status).toBe("contested")
    expect(state.facts?.find((fact) => fact.id === "f2")?.status).toBe("contested")
    expect(state.arbitrations ?? []).toHaveLength(0)
  })

  test("an ambiguous result supersedes both facts", () => {
    let state = contested()
    const arbitration = state.arbitrations![0]!
    state = resolveArbitration(state, { id: arbitration.id, result: "inconclusive", at: 2_000 })

    expect(state.arbitrations?.[0]?.status).toBe("resolved")
    expect(state.facts?.every((fact) => fact.status === "superseded")).toBe(true)
  })

  test("helpers never mutate their input state", () => {
    const state = field()
    proposeFact(state, {
      id: "f1",
      author: "Ada",
      claim: "the reader returns bytes 75 07",
      evidence: ["dump"],
      area: "reader",
      at: 1_000,
    })
    expect(state.facts ?? []).toHaveLength(0)
  })
})
