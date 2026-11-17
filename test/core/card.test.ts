import { describe, expect, test } from "bun:test"
import { openField, type FieldState } from "../../src/core/field.ts"
import { stateCard } from "../../src/core/card.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Make Acrobat 25.1 permanently Pro on this machine",
  constraints: [],
  successCriteria: [],
  nonGoals: [],
}

function field(overrides: Partial<FieldState> = {}): FieldState {
  const base = openField({
    id: "f1",
    parentSessionID: "p",
    contract,
    oracle: {
      observable: "document view has no blue Subscribe button",
      baseline: "capture acrobat-baseline.png",
      kind: "ui",
      confirmed: true,
    },
    members: [
      { label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" },
      { label: "Hypatia", agent: "plan", stance: STANCES[1]!, sessionID: "s2" },
    ],
    now: 1_000,
    budgetMs: 1_200_000,
    checkEveryMs: 5_000,
    maxTurns: 10,
    maxForemanTurns: 0,
  })
  return { ...base, ...overrides }
}

describe("state card", () => {
  test("always names the goal, oracle, truth, lane, now and next", () => {
    const card = stateCard(field(), "Ada", 61_000)
    expect(card).toContain("ARENA f1")
    expect(card).toContain("GOAL")
    expect(card).toContain("ORACLE  confirmed")
    expect(card).toContain("TRUTH")
    expect(card).toContain("LANE")
    expect(card).toContain("NOW")
    expect(card).toContain("NEXT")
    expect(card.split("\n").length).toBeLessThanOrEqual(18)
    expect(card.length).toBeLessThanOrEqual(1_400)
  })

  test("shows the oldest running job as a health line", () => {
    const card = stateCard(field(), "Ada", 61_000, "Ada job_1 190s foreground")
    expect(card).toContain("HEALTH  Ada job_1 190s foreground")
  })

  test("an unconfirmed oracle is the next action and blocks experiments", () => {
    const card = stateCard(field({ oracle: { ...field().oracle!, confirmed: false } }), "Ada", 1_000)
    expect(card).toContain("unconfirmed")
    expect(card).toContain("capture the baseline")
  })

  test("shows the one running experiment and its expected observation", () => {
    const state = field({
      experiments: [
        {
          id: "e1",
          owner: "Ada",
          hypothesis: "level 100 is read at startup",
          command: "start acrobat",
          expect: "NGL log says LICENSE_TYPE_NONE",
          killIf: "log says PRO",
          status: "running",
          evidence: [],
          startedAt: 58_000,
        },
      ],
    })
    const card = stateCard(state, "Ada", 61_000)
    expect(card).toContain("NOW     e1 Ada 00:03")
    expect(card).toContain("LICENSE_TYPE_NONE")
    expect(card).toContain("NEXT    run it, then post kind=result")
  })

  test("counts observed facts, not only formally verified ones", () => {
    const state = field({
      facts: [
        { id: "m1", author: "Ada", claim: "registry is downstream", evidence: ["reg query"], status: "proposed", basedOn: [], at: 1 },
        { id: "m2", author: "Ada", claim: "local patch is refuted", evidence: ["dump"], status: "refuted", basedOn: [], at: 2 },
      ],
    })
    const card = stateCard(state, "Ada", 1_000)
    expect(card).toContain("1 observed | 1 refuted")
    expect(card).toContain("registry is downstream")
  })
})
