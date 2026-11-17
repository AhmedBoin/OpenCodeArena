import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorkspaceManager } from "../src/workspace.ts"

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true })
}

describe("WorkspaceManager", () => {
  test("creates a real git worktree, diffs it, verifies it and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-ws-"))
    try {
      await git(root, ["init"])
      await git(root, ["config", "user.email", "arena@example.test"])
      await git(root, ["config", "user.name", "Arena Test"])
      await writeFile(join(root, "app.ts"), "export const value = 1\n")
      await writeFile(join(root, ".gitignore"), "node_modules\n")
      await git(root, ["add", "."])
      await git(root, ["commit", "-m", "initial"])
      await mkdir(join(root, "node_modules"))
      await writeFile(join(root, "node_modules", "marker.txt"), "installed\n")

      const workspace = new WorkspaceManager()
      const probe = await workspace.probe(root)
      expect(probe.git).toBe(true)

      const created = await workspace.create(root, "run1", "C1", true)
      expect(created.isolated).toBe(true)
      expect(created.branch).toBe("arena/run1/C1")
      const linked = await lstat(join(created.path, "node_modules"))
      expect(linked.isSymbolicLink() || linked.isDirectory()).toBe(true)

      await writeFile(join(created.path, "app.ts"), "export const value = 2\n")
      await writeFile(join(created.path, "new.ts"), "export const added = true\n")
      const diff = await workspace.diff(created)
      expect(diff).toContain("value = 2")
      expect(diff).toContain("new.ts")

      const pass = await workspace.verify(created, `node -e "console.log('METRIC: 7')"`, "C1", 30_000, /METRIC: (\d+)/)
      expect(pass.passed).toBe(true)
      expect(pass.metric).toBe(7)

      const fail = await workspace.verify(created, `node -e "process.exit(3)"`, "C1", 30_000)
      expect(fail.passed).toBe(false)
      expect(fail.exitCode).toBe(3)

      await workspace.remove(root, created)
      const after = await workspace.probe(created.path)
      expect(after.git).toBe(false)
      const marker = await lstat(join(root, "node_modules", "marker.txt"))
      expect(marker.isFile()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  test("three-way merges text and refuses to line-merge binary conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-ws-merge-"))
    try {
      await git(root, ["init"])
      await git(root, ["config", "user.email", "arena@example.test"])
      await git(root, ["config", "user.name", "Arena"])
      await writeFile(join(root, "note.txt"), "base\n")
      await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]))
      await git(root, ["add", "-A"])
      await git(root, ["commit", "-m", "base"])
      const workspace = new WorkspaceManager()
      const a = await workspace.create(root, "merge-run", "A", true)
      const b = await workspace.create(root, "merge-run", "B", true)
      await writeFile(join(a.path, "note.txt"), "from A\n")
      await writeFile(join(b.path, "note.txt"), "from B\n")
      await writeFile(join(a.path, "blob.bin"), Buffer.from([0, 9, 9, 9]))
      await writeFile(join(b.path, "blob.bin"), Buffer.from([0, 8, 8, 8]))
      const result = await workspace.merge!(a, b)
      expect(result.conflicts).toContain("note.txt")
      expect(result.conflicts).toContain("blob.bin")
      expect(await readFile(join(a.path, "note.txt"), "utf8")).toContain("<<<<<<<")
      expect([...await readFile(join(a.path, "blob.bin"))]).toEqual([0, 9, 9, 9])
      await workspace.remove(root, a)
      await workspace.remove(root, b)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("commits a seat branch and merges another branch with a review stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-ws-branch-"))
    try {
      await git(root, ["init"])
      await git(root, ["config", "user.email", "arena@example.test"])
      await git(root, ["config", "user.name", "Arena"])
      await writeFile(join(root, "note.txt"), "base\n")
      await git(root, ["add", "-A"])
      await git(root, ["commit", "-m", "base"])
      const workspace = new WorkspaceManager()
      const runID = `branch-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const a = await workspace.create(root, runID, "A", true)
      const b = await workspace.create(root, runID, "B", true)
      await writeFile(join(a.path, "note.txt"), "from A\n")
      const commitA = await workspace.commit(a, "A changes the note")
      expect(commitA.hash.length).toBeGreaterThan(0)
      await writeFile(join(b.path, "other.txt"), "from B\n")
      await workspace.commit(b, "B adds a file")
      expect(await workspace.log(b)).toContain("B adds a file")

      const merged = await workspace.mergeBranch(b, a.branch!, "merge A")
      expect(merged.ok).toBe(true)
      expect(merged.conflicts).toEqual([])
      expect((await readFile(join(b.path, "note.txt"), "utf8")).trim()).toBe("from A")
      const mergeCommit = await workspace.commit(b, "merge A")
      expect(mergeCommit.hash.length).toBeGreaterThan(0)

      await workspace.remove(root, a)
      await workspace.remove(root, b)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  test("reports merge conflicts and can abort or resolve them", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-ws-conflict-"))
    try {
      await git(root, ["init"])
      await git(root, ["config", "user.email", "arena@example.test"])
      await git(root, ["config", "user.name", "Arena"])
      await writeFile(join(root, "note.txt"), "base\n")
      await git(root, ["add", "-A"])
      await git(root, ["commit", "-m", "base"])
      const workspace = new WorkspaceManager()
      const runID = `conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const a = await workspace.create(root, runID, "A", true)
      const b = await workspace.create(root, runID, "B", true)
      await writeFile(join(a.path, "note.txt"), "from A\n")
      await workspace.commit(a, "A")
      await writeFile(join(b.path, "note.txt"), "from B\n")
      await workspace.commit(b, "B")
      const merged = await workspace.mergeBranch(b, a.branch!, "merge A")
      expect(merged.ok).toBe(false)
      expect(merged.conflicts).toContain("note.txt")
      await workspace.resolve(b, ["note.txt"], "ours")
      const resolved = await workspace.commit(b, "resolve A")
      expect(resolved.hash.length).toBeGreaterThan(0)
      expect((await readFile(join(b.path, "note.txt"), "utf8")).trim()).toBe("from B")
      await workspace.remove(root, a)
      await workspace.remove(root, b)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  test("does not shadow-copy the home directory", async () => {
    const workspace = new WorkspaceManager()
    const created = await workspace.create(homedir(), "home-run", "A", true)
    expect(created.isolated).toBe(false)
    expect(created.path).toBe(homedir())
  })

  test("initializes git in a non-git root and creates a worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "arena-ws-init-"))
    const runID = `init-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await writeFile(join(root, "app.ts"), "const value = 1\n")
      // Mixed endings are common in Windows targets and in binaries. The baseline
      // and its worktree must reproduce the bytes, not apply the user's autocrlf.
      const mixed = Buffer.from("one\ntwo\r\nthree\n", "utf8")
      await writeFile(join(root, "mixed.txt"), mixed)
      const workspace = new WorkspaceManager()
      expect((await workspace.probe(root)).git).toBe(false)
      expect(await workspace.ensureRepository(root)).toBe(true)
      expect((await lstat(join(root, ".git"))).isDirectory()).toBe(true)
      const created = await workspace.create(root, runID, "C1", true)
      expect(created.isolated).toBe(true)
      expect(created.shadow).toBe(false)
      expect(created.path).not.toBe(root)
      expect((await workspace.probe(root)).git).toBe(true)
      expect(await workspace.changedFiles(created)).toEqual([])
      expect([...await readFile(join(created.path, "mixed.txt"))]).toEqual([...mixed])
      await writeFile(join(created.path, "app.ts"), "const value = 2\n")
      expect(await workspace.changedFiles(created)).toContain("app.ts")
      await workspace.remove(root, created)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      await rm(join(tmpdir(), "arena", runID), { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)
})
