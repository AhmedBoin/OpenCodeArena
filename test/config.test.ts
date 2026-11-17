import { describe, expect, test } from "bun:test"
import { chooseContestants, planRun, resolveConfig, type PlanInput } from "../src/config.ts"
import { DEFAULT_CONFIG, type ProblemContract } from "../src/types.ts"

const base: ProblemContract = {
  objective: "Fix the duplicate webhook order bug",
  constraints: [],
  successCriteria: [],
  nonGoals: [],
}

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    contract: base,
    options: {},
    parentAgent: "build",
    availableAgents: ["build", "plan", "uncensored"],
    ...overrides,
  }
}

describe("planRun", () => {
  test("uses the parent agent and default model when nothing is specified", () => {
    const plan = planRun(input())
    expect(plan.agents.every((agent) => agent === "build")).toBe(true)
    expect(plan.models).toEqual([])
    expect(plan.foremanAgent).toBe("plan")
    expect(plan.allowNetwork).toBe(true)
    expect(plan.contestants).toBeGreaterThanOrEqual(2)
    expect(plan.maxTurns).toBe(DEFAULT_CONFIG.maxTurns)
    expect(plan.checkEveryMs).toBe(DEFAULT_CONFIG.checkEveryMinutes * 60_000)
  })

  test("maxSteps and maxTurns are accepted but no longer limit an agent", () => {
    expect(planRun(input({ options: { maxSteps: 30 } })).maxTurns).toBe(0)
    expect(planRun(input({ options: { maxTurns: 10 } })).maxTurns).toBe(0)
    expect(planRun(input({ options: { maxSteps: 0 } })).maxTurns).toBe(0)
  })

  test("mention and lease windows are configurable", () => {
    const plan = planRun(input({ options: { mentionTimeoutSeconds: 90, leaseMinutes: 15 } }))
    expect(plan.mentionTimeoutMs).toBe(90_000)
    expect(plan.intentLeaseMs).toBe(900_000)
  })

  test("infers a same role and a copy-on-write room when no role or crew is given", () => {
    const fix = planRun(input())
    expect(fix.sameRole).toBe("Software Engineer")
    expect(fix.sameRoleInferred).toBe(true)
    expect(fix.workspaceMode).toBe("copy")

    const reverse = planRun(input({ contract: { ...base, objective: "Make Adobe Acrobat 25.1 permanently Pro" } }))
    expect(reverse.sameRole).toBe("Reverse Engineer")

    const multi = planRun(input({ contract: { ...base, objective: "Add login, add audit logging, add rate limiting" } }))
    expect(multi.sameRole).toBeUndefined()
  })

  test("a serialized installed target defaults to two seats unless the user asks for more", () => {
    const serialized = planRun(
      input({
        contract: {
          ...base,
          objective: "Crack the installed UltraISO trial and prove a clean start",
        },
      }),
    )
    expect(serialized.sameRole).toBeTruthy()
    expect(serialized.contestants).toBe(2)
    expect(serialized.reason).toContain("two-seat serialized-target default")

    const explicit = planRun(
      input({
        contract: { ...base, objective: "Crack the installed UltraISO trial" },
        options: { sameRole: "Reverse Engineer", contestants: 3 },
      }),
    )
    expect(explicit.contestants).toBe(3)
  })

  test("sameRole makes every seat the same role in a copy-on-write room", () => {
    const plan = planRun(input({ options: { sameRole: "Builder", contestants: 4 } }))
    expect(plan.sameRole).toBe("Builder")
    expect(plan.workspaceMode).toBe("copy")
    expect(plan.crew.map((seat) => seat.role)).toEqual(["Builder", "Builder", "Builder", "Builder"])
    expect(plan.crew.every((seat) => seat.workstream === undefined)).toBe(true)
    expect(plan.coordination).toBe("independent")
  })

  test("cycles models and agents to the requested count", () => {
    const plan = planRun(
      input({ options: { contestants: 3, agents: ["plan"], models: ["openai/gpt-5", "anthropic/claude#high"] } }),
    )
    expect(plan.agents).toEqual(["plan", "plan", "plan"])
    expect(plan.models).toHaveLength(2)
    expect(plan.models[1]?.variant).toBe("high")
  })

  test("keeps an explicit large crew instead of clamping to a low cap", () => {
    const plan = planRun(input({ options: { contestants: 99 } }))
    expect(plan.contestants).toBe(99)
  })

  test("supports a 50-agent attack with unique seats", () => {
    const plan = planRun(input({ options: { contestants: 50 } }))
    expect(plan.contestants).toBe(50)
    expect(new Set(plan.crew.map((seat) => seat.name)).size).toBe(50)
  })

  test("records a reason that names the crew and the referee", () => {
    const plan = planRun(input())
    expect(plan.reason).toContain(`${plan.contestants}-person crew`)
    expect(plan.reason).toContain(`Referee ${plan.foremanAgent}`)
  })

  test("a shared agent type applies to every seat and a seat can override it", () => {
    const shared = planRun(
      input({
        options: {
          agentType: "uncensored",
          crew: [
            { name: "Ada", brief: "ships it" },
            { name: "Omar", brief: "breaks it" },
          ],
        },
      }),
    )
    expect(shared.crew.map((seat) => seat.agent)).toEqual(["uncensored", "uncensored"])
    const mixed = planRun(
      input({
        options: {
          agentType: "uncensored",
          crew: [
            { name: "Ada", brief: "ships it", agent: "build" },
            { name: "Omar", brief: "breaks it" },
          ],
        },
      }),
    )
    expect(mixed.crew[0]?.agent).toBe("build")
    expect(mixed.crew[1]?.agent).toBe("uncensored")
  })

  test("an authored crew overrides the contestant count and keeps its names", () => {
    const plan = planRun(
      input({
        options: {
          contestants: 2,
          crew: [
            { name: "Ada", role: "Builder", brief: "ships it" },
            { name: "Hypatia", role: "Analyst", brief: "maps it" },
            { name: "Turing", role: "Adversary", brief: "breaks it" },
          ],
        },
      }),
    )
    expect(plan.contestants).toBe(3)
    expect(plan.crew.map((seat) => seat.name)).toEqual(["Ada", "Hypatia", "Turing"])
    expect(plan.reason).toContain("written by the main session")
  })

  test("a fallback crew gets unique names", () => {
    const plan = planRun(input({ options: { contestants: 5 } }))
    expect(new Set(plan.crew.map((seat) => seat.name)).size).toBe(5)
  })

  test("honours a foreman override and its model", () => {
    const plan = planRun(input({ options: { foremanAgent: "uncensored", foremanModel: "openai/gpt-5" } }))
    expect(plan.foremanAgent).toBe("uncensored")
    expect(plan.foremanModel?.id).toBe("gpt-5")
  })
})

describe("chooseContestants", () => {
  test("scales with complexity and respects the cap", () => {
    const simple = chooseContestants(base, resolveConfig())
    const complex = chooseContestants(
      {
        ...base,
        objective: "Refactor the distributed scheduler and improve performance",
        constraints: ["a", "b", "c", "d", "e"],
        successCriteria: ["1", "2", "3", "4", "5"],
        verificationCommand: "bun test",
      },
      resolveConfig(),
    )
    expect(simple).toBeGreaterThanOrEqual(2)
    expect(complex).toBeGreaterThanOrEqual(simple)
    expect(complex).toBeLessThanOrEqual(DEFAULT_CONFIG.maxAgents)
  })
})

describe("resolveConfig", () => {
  test("network is always on", () => {
    expect(resolveConfig().allowNetwork).toBe(true)
    expect(resolveConfig({ network: false }).allowNetwork).toBe(true)
  })

  test("clamps the duration", () => {
    expect(resolveConfig({ maxDurationMinutes: 1 }).maxDurationMinutes).toBe(1)
    expect(resolveConfig({ maxDurationMinutes: 999 }).maxDurationMinutes).toBe(240)
  })

  test("keeps the field defaults", () => {
    expect(resolveConfig().maxTurns).toBe(DEFAULT_CONFIG.maxTurns)
    expect(resolveConfig().checkEveryMinutes).toBe(DEFAULT_CONFIG.checkEveryMinutes)
    expect(resolveConfig().maxForemanTurns).toBe(DEFAULT_CONFIG.maxForemanTurns)
  })
})
