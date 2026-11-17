import { describe, expect, test } from "bun:test"
import { openField, type FieldState } from "../../src/core/field.ts"
import { finishExperiment, runningExperiment, startExperiment } from "../../src/core/experiment.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Test one hypothesis",
  constraints: [],
  successCriteria: [],
  nonGoals: [],
}

function field(overrides: Partial<FieldState> = {}): FieldState {
  const base = openField({
    id: "f1",
    parentSessionID: "p",
    contract,
    oracle: { observable: "the log says OK", baseline: "capture the log", kind: "command", confirmed: true },
    members: [{ label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" }],
    now: 1_000,
    budgetMs: 600_000,
    checkEveryMs: 5_000,
    maxTurns: 10,
    maxForemanTurns: 0,
  })
  return { ...base, ...overrides }
}

const start = {
  owner: "Ada",
  hypothesis: "the level is read at startup",
  command: "start acrobat",
  expect: "log says OK",
  killIf: "log says NONE",
  now: 2_000,
  maxExperiments: 3,
}

describe("experiments", () => {
  test("an experiment needs a confirmed oracle", () => {
    expect(startExperiment(field({ oracle: undefined }), start).error).toContain("no oracle")
    expect(
      startExperiment(field({ oracle: { observable: "x", baseline: "y", kind: "command", confirmed: false } }), start).error,
    ).toContain("unconfirmed")
  })

  test("a baseline from before the field is rejected", () => {
    const stale = field({
      oracle: {
        observable: "the log says OK",
        baseline: "old log",
        kind: "file",
        confirmed: true,
        baselineAt: 500,
      },
    })
    expect(startExperiment(stale, start).error).toContain("predates this field")
  })

  test("different owners can run different resources in parallel, but one owner cannot double-run", () => {
    const first = startExperiment(field(), { ...start, lane: "resource-a" })
    expect(first.experiment?.status).toBe("running")
    const second = startExperiment(first.state, { ...start, owner: "Hypatia", lane: "resource-b" })
    expect(second.error).toBeUndefined()
    expect(second.experiment?.status).toBe("running")
    const sameOwner = startExperiment(second.state, { ...start, lane: "resource-c" })
    expect(sameOwner.error).toContain("already running")
    const sameResource = startExperiment(second.state, { ...start, owner: "Frances", lane: "resource-a" })
    expect(sameResource.error).toContain("resource-a")
  })

  test("a reused process makes the result invalid, not a pass", () => {
    const started = startExperiment(field(), start)
    const finished = finishExperiment(started.state, {
      owner: "Ada",
      id: "e1",
      status: "pass",
      observed: "level=100",
      pidBefore: "4120",
      pidAfter: "4120",
      now: 3_000,
    })
    expect(finished.experiment?.status).toBe("invalid")
    expect(finished.experiment?.result).toContain("same process reused")
  })

  test("a result needs raw output and the owner", () => {
    const started = startExperiment(field(), start)
    expect(finishExperiment(started.state, { owner: "Hypatia", id: "e1", status: "pass", now: 3_000 }).error).toContain(
      "belongs to Ada",
    )
    expect(finishExperiment(started.state, { owner: "Ada", id: "e1", status: "pass", now: 3_000 }).error).toContain(
      "raw output",
    )
  })

  test("a new PID passes and the slot frees", () => {
    const started = startExperiment(field(), start)
    const finished = finishExperiment(started.state, {
      owner: "Ada",
      id: "e1",
      status: "pass",
      observed: "log says OK",
      pidBefore: "4120",
      pidAfter: "5000",
      now: 3_000,
    })
    expect(finished.experiment?.status).toBe("pass")
    expect(runningExperiment(finished.state)).toBeUndefined()
  })

  test("the experiment budget is enforced", () => {
    let state = field()
    for (let index = 0; index < 3; index++) {
      const started = startExperiment(state, start)
      state = started.state
      state = finishExperiment(state, {
        owner: "Ada",
        id: `e${index + 1}`,
        status: "fail",
        observed: "no change",
        now: 3_000 + index,
      }).state
    }
    expect(startExperiment(state, start).error).toContain("budget spent")
  })
})
