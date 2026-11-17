import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { killProcessTree } from "../src/process.ts"

describe("process cleanup", () => {
  test("kills a process that would otherwise keep the Arena lock open", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    await killProcessTree(child.pid)
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("process did not exit")), 3_000)),
    ])
    expect(child.exitCode !== null || child.killed).toBe(true)
  })
})
