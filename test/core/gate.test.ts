import { describe, expect, test } from "bun:test"
import { judgeClaim } from "../../src/core/gate.ts"

const claim = { label: "Ada", text: "the boundary case holds", evidence: ["bun test -> 0 fail"] }

describe("claim gate", () => {
  test("accepts a verified claim the falsifier could not break", () => {
    const result = judgeClaim({
      claim,
      attempts: 0,
      hasCommand: true,
      verification: { ok: true, output: "pass" },
      falsifier: { falsified: false, reason: "could not break it" },
      maxAttempts: 2,
    })
    expect(result.accepted).toBe(true)
    expect(result.final).toBe(false)
  })

  test("rejects a claim whose verification failed", () => {
    const result = judgeClaim({
      claim,
      attempts: 0,
      hasCommand: true,
      verification: { ok: false, output: "1 fail" },
      maxAttempts: 2,
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain("verification")
    expect(result.final).toBe(false)
  })

  test("rejects a claim when the declared verification never ran", () => {
    const result = judgeClaim({ claim, attempts: 0, hasCommand: true, maxAttempts: 2 })
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain("did not run")
  })

  test("rejects a claim with no evidence when no command exists", () => {
    const result = judgeClaim({ claim: { ...claim, evidence: [] }, attempts: 0, hasCommand: false, maxAttempts: 2 })
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain("evidence")
  })

  test("rejects a claim a peer falsified, naming the test", () => {
    const result = judgeClaim({
      claim,
      attempts: 0,
      hasCommand: true,
      verification: { ok: true, output: "pass" },
      falsifier: { falsified: true, reason: "counterexample at n=0", test: "bun run check" },
      maxAttempts: 2,
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain("n=0")
  })

  test("accepts a coverage claim with evidence even when the full objective command fails", () => {
    const result = judgeClaim({
      claim: {
        label: "Ada",
        text: "proved the local boundary; the remote half is out of reach",
        evidence: ["bun test -> 12 pass"],
        coverage: ["local boundary proven", "remote half not reachable"],
      },
      attempts: 0,
      hasCommand: true,
      verification: { ok: false, output: "remote check failed" },
      maxAttempts: 2,
    })
    expect(result.accepted).toBe(true)
    expect(result.reason).toContain("coverage accepted")
  })

  test("a coverage claim without evidence is rejected", () => {
    const result = judgeClaim({
      claim: { label: "Ada", text: "partial", evidence: [], coverage: ["only one route"] },
      attempts: 0,
      hasCommand: false,
      maxAttempts: 2,
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain("needs evidence")
  })

  test("accepts without a command when evidence exists and nobody falsified it", () => {
    const result = judgeClaim({ claim, attempts: 0, hasCommand: false, falsifier: { falsified: false, reason: "ok" }, maxAttempts: 2 })
    expect(result.accepted).toBe(true)
  })

  test("marks the second rejection final", () => {
    const result = judgeClaim({ claim: { ...claim, evidence: [] }, attempts: 1, hasCommand: false, maxAttempts: 2 })
    expect(result.accepted).toBe(false)
    expect(result.final).toBe(true)
  })
})
