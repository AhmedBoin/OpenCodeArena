import { beforeEach, describe, expect, test } from "bun:test"
import { isSealed, resetSeals, sealOf, sealSession, unsealSession } from "../src/seal.ts"

describe("sealed field sessions", () => {
  beforeEach(() => resetSeals())

  test("a seal records the label, run and reason", () => {
    sealSession("s1", { label: "Ada", runID: "f1", reason: "done", at: 10 })
    expect(isSealed("s1")).toBe(true)
    expect(sealOf("s1")).toEqual({ label: "Ada", runID: "f1", reason: "done", at: 10 })
  })

  test("a leave seal cannot be unsealed", () => {
    sealSession("s-left", { label: "Ada", runID: "f1", reason: "left", at: 10 })
    unsealSession("s-left")
    expect(isSealed("s-left")).toBe(true)
    expect(sealOf("s-left")?.reason).toBe("left")
  })

  test("an empty session id is never sealed", () => {
    sealSession("", { label: "Ada", runID: "f1", reason: "done", at: 10 })
    expect(isSealed("")).toBe(false)
  })

  test("only an explicit unseal opens a session again", () => {
    sealSession("s1", { label: "Ada", runID: "f1", reason: "field-closed", at: 10 })
    unsealSession("s1")
    expect(isSealed("s1")).toBe(false)
    expect(sealOf("s1")).toBeUndefined()
  })

  test("a reset models a fresh process", () => {
    sealSession("s1", { label: "Ada", runID: "f1", reason: "stopped", at: 10 })
    resetSeals()
    expect(isSealed("s1")).toBe(false)
  })
})
