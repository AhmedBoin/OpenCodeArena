import { describe, expect, test } from "bun:test"
import { parseRoomCommand } from "../src/commands.ts"

describe("room commands", () => {
  test("recognizes an explicit stop", () => {
    for (const text of ["stop", "Stop.", "please stop", "stop now", "stop everything", "/stop", "halt", "pause", "enough"]) {
      expect(parseRoomCommand(text)).toBe("stop")
    }
  })

  test("recognizes a continue", () => {
    for (const text of ["continue", "Continue.", "please continue", "continue now", "resume", "keep going", "carry on", "go on", "proceed", "unpause"]) {
      expect(parseRoomCommand(text)).toBe("continue")
    }
  })

  test("leaves ordinary instructions alone", () => {
    for (const text of [
      "",
      "stop the retry loop",
      "stop after the current test",
      "do not stop",
      "continue the migration later",
      "continue with the parser",
      "the parser must continue after a blank line",
      "status",
      "hello everyone",
    ]) {
      expect(parseRoomCommand(text)).toBeUndefined()
    }
  })
})
