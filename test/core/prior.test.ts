import { describe, expect, test } from "bun:test"
import { openField } from "../../src/core/field.ts"
import { objectiveKey, priorFromReport, priorLine, seedPrior } from "../../src/core/prior.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Make Acrobat 25.1 permanently Pro",
  constraints: [],
  successCriteria: [],
  nonGoals: [],
}

function field() {
  return openField({
    id: "f2",
    parentSessionID: "p",
    contract,
    members: [{ label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" }],
    now: 1_000,
    budgetMs: 600_000,
    checkEveryMs: 5_000,
    maxTurns: 10,
    maxForemanTurns: 0,
  })
}

const prior = priorFromReport({
  objective: contract.objective,
  runID: "old",
  at: 500,
  report: {
    outcome: "negative",
    proven: ["the gate is signed remotely"],
    unproven: [],
    artifacts: [],
    nextRoutes: ["patch the NGL verdict"],
    reason: "2 observed, 3 refuted",
  },
  facts: [
    { id: "m1", author: "Ada", claim: "the registry is decoration", evidence: ["reg query"], status: "refuted", basedOn: [], at: 1 },
    { id: "m2", author: "Ada", claim: "the gate is signed remotely", evidence: ["strings"], status: "verified", basedOn: [], at: 2 },
    { id: "m3", author: "Ada", claim: "the registry is decoration", evidence: [], status: "proposed", basedOn: [], at: 3 },
  ],
})

describe("prior memory", () => {
  test("the objective key is stable and objective-specific", () => {
    expect(objectiveKey("A b  C")).toBe(objectiveKey("a B c"))
    expect(objectiveKey("one")).not.toBe(objectiveKey("two"))
  })

  test("prior facts are seeded as assumed, deduplicated and linked to the old run", () => {
    const state = seedPrior(field(), prior, 2_000)
    expect(state.facts?.filter((fact) => fact.status === "assumed")).toHaveLength(2)
    expect(state.prior?.runID).toBe("old")
    expect(state.prior?.routes).toContain("patch the NGL verdict")
    expect(priorLine(state)).toContain("do not re-derive")
  })

  test("seeding is idempotent and never overrides an observed fact", () => {
    const once = seedPrior(field(), prior, 2_000)
    const twice = seedPrior(once, prior, 3_000)
    expect(twice.facts?.filter((fact) => fact.status === "assumed")).toHaveLength(2)
  })
})
