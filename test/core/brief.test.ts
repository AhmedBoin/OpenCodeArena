import { describe, expect, test } from "bun:test"
import { analyzeBrief } from "../../src/core/brief.ts"
import { DEFAULT_CONFIG, type ProblemContract } from "../../src/types.ts"

function contract(objective: string, extra: Partial<ProblemContract> = {}): ProblemContract {
  return {
    objective,
    constraints: [],
    successCriteria: [],
    nonGoals: [],
    ...extra,
  }
}

describe("analyzeBrief", () => {
  test("a short single-lane fix gets two agents", () => {
    const analysis = analyzeBrief(contract("Fix the typo in README"))
    expect(analysis.recommendedAgents).toBe(2)
    expect(analysis.coordination).toBe("split")
    expect(analysis.hypotheses).toHaveLength(1)
  })

  test("an installed-target brief serializes its attack lanes", () => {
    const analysis = analyzeBrief(contract("Make Adobe Acrobat 25.1 permanently Pro on this machine"))
    expect(analysis.coordination).toBe("split")
    expect(analysis.recommendedAgents).toBeGreaterThanOrEqual(4)
    expect(analysis.hypotheses.length).toBeGreaterThanOrEqual(2)
    expect(analysis.doneWhen.length).toBeGreaterThan(0)
    expect(analysis.negativeWhen.length).toBeGreaterThan(0)
  })

  test("an explicit 50-agent attack is not capped to a small crew", () => {
    const analysis = analyzeBrief(contract("Run 50 attackers in parallel against the login boundary"))
    expect(analysis.recommendedAgents).toBe(50)
  })

  test("every analysis carries an observable oracle and a baseline", () => {
    const analysis = analyzeBrief(contract("Make Adobe Acrobat 25.1 permanently Pro on this machine"))
    expect(analysis.oracle.observable.length).toBeGreaterThan(20)
    expect(analysis.oracle.baseline.length).toBeGreaterThan(10)
    expect(analysis.oracle.confirmed).toBe(false)
    expect(analysis.oracle.kind).toBe("ui")
  })

  test("a large migration can scale while staying under the hard cap", () => {
    const analysis = analyzeBrief(contract("Migrate 100 markdown files to the new frontmatter format"))
    expect(analysis.recommendedAgents).toBeLessThanOrEqual(DEFAULT_CONFIG.hardMaxAgents)
    expect(["migrate", "batch"]).toContain(analysis.shape)
  })

  test("independent deliverables get disjoint split lanes", () => {
    const analysis = analyzeBrief(contract("Add login, add audit logging, add rate limiting"))
    expect(analysis.coordination).toBe("split")
    expect(analysis.workstreams.length).toBeGreaterThanOrEqual(3)
    const owned = analysis.workstreams.flatMap((lane) => lane.owns)
    expect(owned.length).toBeGreaterThan(0)
  })

  test("multiple approaches to one target are a race, not a split", () => {
    const analysis = analyzeBrief(contract("Try three different approaches to bypass the same login"))
    expect(analysis.coordination).toBe("race")
    const attempts = analysis.workstreams.filter((lane) => lane.kind === "attack")
    expect(attempts.length).toBeGreaterThanOrEqual(3)
    expect(new Set(attempts.flatMap((lane) => lane.owns)).size).toBeLessThanOrEqual(2)
  })
})
