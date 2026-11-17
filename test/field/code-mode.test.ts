import { describe, expect, test } from "bun:test"
import {
  ARENA_CONTROL_TOOLS,
  COORDINATOR_UI_CODE_TOOLS,
  arenaOnlyCode,
} from "../../src/field/code-mode.ts"

describe("Code Mode routing", () => {
  test("a coordinator may paint the plan band, but a field seat may not", () => {
    const body = { code: "return await tools.deck_progress({ point: 1, state: 'done' })" }
    expect(arenaOnlyCode(body, COORDINATOR_UI_CODE_TOOLS)).toBe(true)
    expect(arenaOnlyCode(body, ARENA_CONTROL_TOOLS)).toBe(false)
  })

  test("Code Mode still cannot smuggle a host tool", () => {
    expect(arenaOnlyCode({ code: "return await tools.shell({ command: 'whoami' })" }, COORDINATOR_UI_CODE_TOOLS)).toBe(
      false,
    )
  })
})
