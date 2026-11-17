import { describe, expect, test } from "bun:test"
import { ensureGit } from "../src/git.ts"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

describe("git bootstrap", () => {
  test("resolves a working git binary", async () => {
    const git = await ensureGit()
    const result = await execFileAsync(git, ["--version"], { windowsHide: true })
    expect(result.stdout.toLowerCase()).toContain("git version")
  })
})
