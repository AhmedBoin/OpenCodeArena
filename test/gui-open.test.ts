import { describe, expect, test } from "bun:test"
import { arenaRunToOpen } from "../src/gui-open.ts"

describe("arena tab auto-open", () => {
  test("returns the run key for a live run in the watched session", () => {
    expect(
      arenaRunToOpen({
        sessionID: "s1",
        key: "srv:s1",
        watched: "srv:s1",
        field: { runID: "r1", status: "running" },
      }),
    ).toBe("s1:r1")
  })

  test("ignores a closed run", () => {
    expect(
      arenaRunToOpen({
        sessionID: "s1",
        key: "srv:s1",
        watched: "srv:s1",
        field: { runID: "r1", status: "done" },
      }),
    ).toBeUndefined()
  })

  test("ignores a state from another watched session", () => {
    expect(
      arenaRunToOpen({
        sessionID: "s2",
        key: "srv:s2",
        watched: "srv:s1",
        field: { runID: "r1", status: "running" },
      }),
    ).toBeUndefined()
  })

  test("ignores an empty board", () => {
    expect(
      arenaRunToOpen({
        sessionID: "s1",
        key: "srv:s1",
        watched: "srv:s1",
        field: { runID: "", status: "none" },
      }),
    ).toBeUndefined()
  })
})
