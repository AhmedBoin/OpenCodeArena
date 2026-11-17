import { describe, expect, test } from "bun:test"
import { openField, type FieldClaim, type FieldState } from "../../src/core/field.ts"
import { buildReport } from "../../src/core/report.ts"
import type { Fact, HypothesisRecord, ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Fix the duplicate webhook order bug without changing the public API",
  constraints: ["keep the public API"],
  successCriteria: ["duplicate events create exactly one order"],
  nonGoals: [],
}

function field(overrides: Partial<FieldState> = {}): FieldState {
  const base = openField({
    id: "field-1",
    parentSessionID: "ses_parent",
    contract,
    members: [],
    now: 1_000,
    budgetMs: 60_000,
    checkEveryMs: 5_000,
    maxTurns: 10,
    maxForemanTurns: 2,
  })
  return { ...base, ...overrides }
}

let seq = 0

function fact(status: Fact["status"], author: string, claim: string, evidence: string[] = []): Fact {
  seq += 1
  return {
    id: `fact-${seq}`,
    author,
    claim,
    evidence,
    status,
    basedOn: [],
    at: 1_000 + seq,
  }
}

function hypothesis(status: HypothesisRecord["status"], statement: string, test: string): HypothesisRecord {
  seq += 1
  return {
    id: `hyp-${seq}`,
    statement,
    test,
    killIf: "the test above fails",
    status,
  }
}

function claim(text: string, evidence: string[] = []): FieldClaim {
  return { label: "Ada", text, evidence, attempts: 0, at: 2_000 }
}

describe("field report", () => {
  test("an empty open field reports inconclusive without crashing", () => {
    const report = buildReport(field())
    expect(report.outcome).toBe("inconclusive")
    expect(report.proven).toEqual([])
    expect(report.unproven).toEqual([])
    expect(report.artifacts).toEqual([])
    expect(report.nextRoutes).toEqual([])
    expect(report.reason.length).toBeGreaterThan(0)
  })

  test("a state missing its optional arrays is still reportable", () => {
    const sparse = { ...field(), facts: undefined, hypotheses: undefined } as unknown as FieldState
    expect(() => buildReport(sparse)).not.toThrow()
    expect(buildReport(sparse).outcome).toBe("inconclusive")
    expect(buildReport(sparse).proven).toEqual([])
  })

  test("an open hypothesis keeps the field inconclusive until every hypothesis is refuted", () => {
    const verified = fact("verified", "Ada", "remote signed gate")
    const refuted = hypothesis("refuted", "local byte patch", "apply the local byte patch")
    const open = hypothesis("open", "remote signed gate bypass", "run the remote proof")

    const withOpen = buildReport(field({ facts: [verified], hypotheses: [refuted, open] }))
    expect(withOpen.outcome).toBe("inconclusive")
    expect(withOpen.proven).toContain("Ada: remote signed gate")
    expect(withOpen.unproven.some((line) => line.includes("remote signed gate bypass"))).toBe(true)
    expect(withOpen.nextRoutes).toContain("run the remote proof")

    const allRefuted = buildReport(
      field({ facts: [verified], hypotheses: [refuted, { ...open, status: "refuted" as const }] }),
    )
    expect(allRefuted.outcome).toBe("negative")
    expect(allRefuted.nextRoutes).toEqual([])
  })

  test("an accepted claim makes the report accepted and puts its text in proven", () => {
    const state = field({
      claims: [claim("duplicate webhook events create exactly one order", ["/tmp/proof.log"])],
      closed: { decision: "accepted", reason: "the gate passed", evidence: "bun test test/webhook.test.ts", at: 3_000 },
    })
    const report = buildReport(state)
    expect(report.outcome).toBe("accepted")
    expect(report.proven).toContain("duplicate webhook events create exactly one order")
    expect(report.reason).toBe("accepted: duplicate webhook events create exactly one order")
  })

  test("a claim marked accepted is accepted even without a closed field", () => {
    const accepted = { ...claim("the retry loop is bounded"), accepted: true } as unknown as FieldClaim
    const state = field({ claims: [accepted], hypotheses: [hypothesis("refuted", "unbounded retries", "run the retry test")] })
    const report = buildReport(state)
    expect(report.outcome).toBe("accepted")
    expect(report.proven).toContain("the retry loop is bounded")
  })

  test("a contested fact is unproven, not proven", () => {
    const report = buildReport(field({ facts: [fact("contested", "Priya", "the flag is not the oracle")] }))
    expect(report.outcome).toBe("inconclusive")
    expect(report.unproven).toContain("contested: the flag is not the oracle")
    expect(report.proven).toEqual([])
  })

  test("a reported stop with no open route is negative", () => {
    const report = buildReport(
      field({
        stopReason: "reported",
        facts: [fact("verified", "Ada", "remote signed gate")],
        hypotheses: [hypothesis("supported", "the gate is signed remotely", "run the remote proof")],
      }),
    )
    expect(report.outcome).toBe("negative")
    expect(report.nextRoutes).toContain("test the remaining route: run the remote proof")
  })

  test("artifacts keep only unique path-like evidence, in order, capped at 20", () => {
    const paths = Array.from({ length: 22 }, (_, index) => `C:\\work\\artifact-${index}.log`)
    const state = field({
      facts: [
        fact("verified", "Ada", "the gate is remote", [
          "/tmp/proof.log",
          "C:\\work\\artifact-0.log",
          "bun test passed",
          "/tmp/proof.log",
        ]),
        fact("verified", "Curie", "the server signs the gate", [
          "\\\\server\\share\\dump.bin",
          "src\\core\\report.ts",
          ...paths,
        ]),
      ],
    })

    const artifacts = buildReport(state).artifacts
    expect(artifacts).toHaveLength(20)
    expect(new Set(artifacts).size).toBe(20)
    expect(artifacts.slice(0, 4)).toEqual([
      "/tmp/proof.log",
      "C:\\work\\artifact-0.log",
      "\\\\server\\share\\dump.bin",
      "src\\core\\report.ts",
    ])
    expect(artifacts.filter((path) => path === "/tmp/proof.log")).toHaveLength(1)
    expect(artifacts).not.toContain("bun test passed")
    expect(artifacts).toContain("C:\\work\\artifact-16.log")
    expect(artifacts).not.toContain("C:\\work\\artifact-17.log")
  })

  test("a field with observed facts and refuted routes is negative even without a claim", () => {
    const state = field({
      facts: [
        fact("proposed", "Ada", "the registry value is downstream", ["reg query ..."]),
        fact("refuted", "Ada", "a registry write flips the product mode", ["launch -> reverted"]),
      ],
      stopReason: "reported",
    })
    const report = buildReport(state)
    expect(report.outcome).toBe("negative")
    expect(report.proven).toContain("Ada: the registry value is downstream")
    expect(report.refuted).toContain("Ada: a registry write flips the product mode")
    expect(report.reason).toContain("observed fact")
  })

  test("building a report never mutates the state", () => {
    const state = field({
      facts: [fact("verified", "Ada", "remote signed gate", ["/tmp/proof.log"])],
      hypotheses: [hypothesis("open", "remote signed gate bypass", "run the remote proof")],
      claims: [claim("candidate fix")],
    })
    const before = structuredClone(state)
    buildReport(state)
    expect(state).toEqual(before)
  })
})
