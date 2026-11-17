import { describe, expect, test } from "bun:test"
import { withRunLock } from "../../src/core/mutex.ts"

describe("arena run lock", () => {
  test("serializes two mutations without an external lock tool", async () => {
    let active = 0
    let max = 0
    const run = `test-lock-${Date.now()}`
    const work = () =>
      withRunLock(run, async () => {
        active += 1
        max = Math.max(max, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        active -= 1
      })
    await Promise.all([work(), work()])
    expect(max).toBe(1)
    expect(active).toBe(0)
  })

  test("two different resources in one run can proceed in parallel", async () => {
    let active = 0
    let max = 0
    const run = `test-resource-${Date.now()}`
    const work = (resource: string) =>
      withRunLock(`${run}:${resource}`, async () => {
        active += 1
        max = Math.max(max, active)
        await new Promise((resolve) => setTimeout(resolve, 40))
        active -= 1
      })
    await Promise.all([work("a"), work("b")])
    expect(max).toBe(2)
  })
})
