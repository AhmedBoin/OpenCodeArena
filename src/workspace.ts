import { exec, execFile } from "node:child_process"
import { lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"

import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { copyForShadow, ensureGit } from "./git.ts"
import type { VerificationResult } from "./types.ts"

const execFileAsync = promisify(execFile)

// Raw command output is evidence. A 12KB cut hid the rows that prove a live
// finding; keep the full dump and let the inbox budget decide what reaches a turn.
const MAX_OUTPUT = 200_000

function execShell(
  command: string,
  options: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export interface GitState {
  git: boolean
  root: string
}

export interface Workspace {
  label: string
  path: string
  branch?: string
  isolated: boolean
  /** The repository the worktree belongs to: the working-directory repo or the fallback shadow. */
  repoRoot?: string
  /** True when repoRoot is an Arena shadow repository, not the user's repo. */
  shadow?: boolean
}

export interface WorkspacePort {
  probe(directory: string): Promise<GitState>
  /** Initialize the working directory as a repository when it has none; never for home/drive roots. */
  ensureRepository?(root: string): Promise<boolean>
  /** False for a home/drive root, where a private worktree would be unsafe. */
  canIsolate?(root: string): Promise<boolean>
  create(root: string, runID: string, label: string, useWorktrees: boolean): Promise<Workspace>
  remove(root: string, workspace: Workspace): Promise<void>
  cleanupRun?(runID: string): Promise<void>
  changedFiles(workspace: Workspace): Promise<string[]>
  diff(workspace: Workspace, limit?: number): Promise<string>
  merge?(
    target: Workspace,
    source: Workspace,
  ): Promise<{ merged: string[]; conflicts: string[]; output: string }>
  commit?(workspace: Workspace, message: string): Promise<{ hash: string; output: string }>
  log?(workspace: Workspace, limit?: number): Promise<string>
  mergeBranch?(
    target: Workspace,
    sourceBranch: string,
    message: string,
  ): Promise<{ ok: boolean; conflicts: string[]; output: string }>
  abortMerge?(workspace: Workspace): Promise<string>
  resolve?(workspace: Workspace, paths: string[], take: "ours" | "theirs"): Promise<string>
  verify(
    workspace: Workspace,
    command: string | undefined,
    label: string,
    timeoutMs: number,
    metricPattern?: RegExp,
  ): Promise<VerificationResult>
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  durationMs: number
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8_192).includes(0)
}

function trim(text: string, limit = MAX_OUTPUT): string {
  const value = text.trim()
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value
}

async function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now()
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return { stdout: result.stdout, stderr: result.stderr, code: 0, durationMs: Date.now() - started }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string }
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
      code: typeof failure.code === "number" ? failure.code : failure.killed ? 124 : 1,
      durationMs: Date.now() - started,
    }
  }
}

/**
 * Native workspace manager. No containers: a git worktree per agent from the
 * working directory's repository (initialized when missing), otherwise the shared
 * directory when the root cannot be isolated.
 */
export class WorkspaceManager {
  private readonly cache = new Map<string, GitState>()
  private readonly shadowRepos = new Map<string, string>()

  private async git(args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
    const binary = await ensureGit()
    return run(binary, args, cwd, timeoutMs)
  }

  async canIsolate(root: string): Promise<boolean> {
    return !this.unsafeRoot(root)
  }

  /**
   * Make the working directory a repository before any seat starts. Home and drive
   * roots are left alone, an existing repository is reused, and a read-only root
   * simply reports false so the field can continue with the shared or shadow path.
   */
  async ensureRepository(root: string): Promise<boolean> {
    if (this.unsafeRoot(root)) return false
    const state = await this.probe(root)
    if (state.git) return true
    return this.initRepository(root)
  }

  async probe(directory: string): Promise<GitState> {
    const cached = this.cache.get(directory)
    if (cached) return cached
    const result = await this.git(["-C", directory, "rev-parse", "--show-toplevel"], directory, 15_000)
    const state: GitState = result.code === 0 && result.stdout.trim().length > 0
      ? { git: true, root: result.stdout.trim() }
      : { git: false, root: directory }
    this.cache.set(directory, state)
    return state
  }

  /** Home/drive roots are not project workspaces; copying them can take forever. */
  private unsafeRoot(root: string): boolean {
    const normalize = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    const target = normalize(root)
    const home = normalize(homedir())
    return target === home || target === normalize(dirname(home)) || /^[a-z]:$/.test(target)
  }

  async create(root: string, runID: string, label: string, useWorktrees: boolean): Promise<Workspace> {
    if (!useWorktrees) return { label, path: root, isolated: false }
    if (this.unsafeRoot(root)) return { label, path: root, isolated: false }
    const repo = await this.ensureRepo(root, runID)
    const directory = join(tmpdir(), "arena", runID, label)
    const branch = `arena/${runID}/${label}`
    await mkdir(join(tmpdir(), "arena", runID), { recursive: true })
    const result = await this.git(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-C",
        repo.root,
        "worktree",
        "add",
        "-B",
        branch,
        directory,
        "HEAD",
      ],
      repo.root,
      60_000,
    )
    if (result.code !== 0) {
      throw new Error(`git worktree failed for ${label}: ${trim(result.stderr || result.stdout, 2_000)}`)
    }
    await this.linkNodeModules(root, directory)
    return { label, path: directory, branch, isolated: true, repoRoot: repo.root, shadow: repo.shadow }
  }

  /**
   * Initialize the working directory itself as the baseline repository, so the
   * seats share the project's real history instead of a copy in temp. Heavy or
   * generated directories are excluded through `.git/info/exclude` rather than a
   * tracked `.gitignore`, and byte-preserving checkout settings are local to this
   * repository. A read-only root simply returns false and falls back to a shadow.
   */
  private async initRepository(root: string): Promise<boolean> {
    const init = await this.git(["-C", root, "init"], root, 30_000)
    if (init.code !== 0) return false
    const exclude = join(root, ".git", "info", "exclude")
    await mkdir(dirname(exclude), { recursive: true })
    const current = await readFile(exclude, "utf8").catch(() => "")
    const patterns = ["node_modules/", "dist/", "build/", ".next/", ".cache/", ".arena/", ".arena-vcs/"]
    const missing = patterns.filter((pattern) => !current.split(/\r?\n/).includes(pattern))
    if (missing.length > 0) {
      const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current
      await writeFile(exclude, `${prefix}${missing.join("\n")}\n`)
    }
    await this.git(["-C", root, "config", "core.autocrlf", "false"], root, 15_000)
    await this.git(["-C", root, "config", "core.safecrlf", "false"], root, 15_000)
    await mkdir(join(root, ".git", "info"), { recursive: true })
    await writeFile(join(root, ".git", "info", "attributes"), "* -text\n")
    const add = await this.git(["-C", root, "add", "-A"], root, 120_000)
    if (add.code !== 0) return false
    const commit = await this.git(
      [
        "-c",
        "user.name=Arena",
        "-c",
        "user.email=arena@local",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        "commit",
        "--allow-empty",
        "-m",
        "arena baseline",
      ],
      root,
      120_000,
    )
    if (commit.code !== 0) return false
    this.cache.set(root, { git: true, root })
    return true
  }

  /**
   * A non-git working directory is initialized in place so Arena uses real
   * worktrees from the project's own repository. Only a root that cannot be
   * initialized falls back to the old shadow copy in temp.
   */
  private async ensureRepo(root: string, runID: string): Promise<{ root: string; shadow: boolean }> {
    const state = await this.probe(root)
    if (state.git) return { root: state.root, shadow: false }
    if (await this.initRepository(root)) return { root, shadow: false }
    const existing = this.shadowRepos.get(runID)
    if (existing) return { root: existing, shadow: true }
    const shadow = join(tmpdir(), "arena", "repos", runID, "repo")
    await mkdir(join(tmpdir(), "arena", "repos", runID), { recursive: true })
    await copyForShadow(root, shadow)
    const init = await this.git(["-C", shadow, "init"], shadow, 30_000)
    if (init.code !== 0) throw new Error(`git init failed: ${trim(init.stderr, 2_000)}`)
    await this.git(["-C", shadow, "config", "user.email", "arena@local"], shadow, 15_000)
    await this.git(["-C", shadow, "config", "user.name", "Arena"], shadow, 15_000)
    // A copy of a target must be byte-identical. A Windows global autocrlf=true
    // rewrites LF to CRLF on checkout, so the agent's "same file" hash differs
    // from the baseline before it has changed anything. This repository belongs
    // to Arena, so it can disable conversion for every path.
    await this.git(["-C", shadow, "config", "core.autocrlf", "false"], shadow, 15_000)
    await this.git(["-C", shadow, "config", "core.safecrlf", "false"], shadow, 15_000)
    await mkdir(join(shadow, ".git", "info"), { recursive: true })
    await writeFile(join(shadow, ".git", "info", "attributes"), "* -text\n")
    const add = await this.git(["-C", shadow, "add", "-A"], shadow, 30_000)
    if (add.code !== 0) throw new Error(`git add failed: ${trim(add.stderr, 2_000)}`)
    let commit = await this.git(["-C", shadow, "commit", "-m", "arena baseline"], shadow, 60_000)
    if (commit.code !== 0 && /nothing to commit|no changes/i.test(`${commit.stdout}${commit.stderr}`)) {
      await writeFile(join(shadow, ".arena-baseline"), "")
      await this.git(["-C", shadow, "add", ".arena-baseline"], shadow, 15_000)
      commit = await this.git(["-C", shadow, "commit", "-m", "arena baseline"], shadow, 60_000)
    }
    if (commit.code !== 0) {
      throw new Error(`git commit failed: ${trim(commit.stderr, 2_000)}`)
    }
    this.shadowRepos.set(runID, shadow)
    return { root: shadow, shadow: true }
  }

  async cleanupRun(runID: string): Promise<void> {
    const shadow = this.shadowRepos.get(runID) ?? join(tmpdir(), "arena", "repos", runID, "repo")
    this.shadowRepos.delete(runID)
    await rm(shadow, { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * A fresh worktree does not contain node_modules, so a JS test command would
   * fail for the wrong reason. Link the root install into the worktree instead
   * of copying it. This is a native directory link, not a container.
   */
  private async linkNodeModules(root: string, worktree: string): Promise<void> {
    const source = join(root, "node_modules")
    const target = join(worktree, "node_modules")
    try {
      await lstat(source)
    } catch {
      return
    }
    try {
      await lstat(target)
      return
    } catch {
      // The target is expected to be absent.
    }
    try {
      await symlink(source, target, process.platform === "win32" ? "junction" : "dir")
    } catch {
      // A failed link is visible in the verification output; do not hide the worktree.
    }
  }

  async remove(root: string, workspace: Workspace): Promise<void> {
    if (!workspace.isolated) return
    const link = join(workspace.path, "node_modules")
    try {
      const info = await lstat(link)
      if (info.isSymbolicLink()) await unlink(link)
      else await rm(link, { recursive: true, force: true })
    } catch {
      // The link is absent or already removed.
    }
    const repo = workspace.repoRoot ?? root
    const result = await this.git(["-C", repo, "worktree", "remove", "--force", workspace.path], repo, 60_000)
    if (result.code !== 0) {
      await rm(workspace.path, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async changedFiles(workspace: Workspace): Promise<string[]> {
    if (!workspace.isolated) return []
    const result = await this.git(["-C", workspace.path, "status", "--porcelain"], workspace.path, 30_000)
    if (result.code !== 0) return []
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0)
      .slice(0, 200)
  }

  async diff(workspace: Workspace, limit = 16_000): Promise<string> {
    if (!workspace.isolated) {
      const state = await this.probe(workspace.path)
      if (!state.git) return ""
      const tracked = await this.git(["-C", workspace.path, "diff", "--no-color"], workspace.path, 60_000)
      const status = await this.git(["-C", workspace.path, "status", "--porcelain"], workspace.path, 30_000)
      const untracked = status.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("??"))
        .map((line) => line.slice(3).trim())
      return trim(`${tracked.stdout}\n${untracked.length > 0 ? `Untracked files:\n${untracked.join("\n")}` : ""}`, limit)
    }
    await this.git(["-C", workspace.path, "add", "-A", "--", ".", ":(exclude)node_modules"], workspace.path, 30_000)
    const result = await this.git(["-C", workspace.path, "diff", "--cached", "--no-color", "HEAD"], workspace.path, 60_000)
    if (result.code !== 0) return trim(result.stderr, limit)
    return trim(result.stdout, limit)
  }

  /**
   * File-level three-way merge from another agent's worktree. Text uses git's
   * merge-file; binary files never get line-merged. If both sides changed a
   * binary differently, it is a conflict and the target file is left untouched.
   */
  async merge(
    target: Workspace,
    source: Workspace,
  ): Promise<{ merged: string[]; conflicts: string[]; output: string }> {
    const changed = new Set(await this.changedFiles(source))
    const targetChanged = new Set(await this.changedFiles(target))
    const merged: string[] = []
    const conflicts: string[] = []
    const work = join(tmpdir(), "arena", "merge", `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(work, { recursive: true })
    try {
      for (const path of changed) {
        if (!path || path.includes("..")) continue
        const theirsPath = join(source.path, path)
        const oursPath = join(target.path, path)
        const theirs = await readFile(theirsPath).catch(() => undefined)
        const ours = await readFile(oursPath).catch(() => undefined)
        const oursChanged = targetChanged.has(path)
        if (!theirs) {
          if (!oursChanged) {
            await rm(oursPath, { force: true }).catch(() => undefined)
            merged.push(path)
          } else {
            conflicts.push(path)
          }
          continue
        }
        if (!oursChanged) {
          await mkdir(dirname(oursPath), { recursive: true })
          await writeFile(oursPath, theirs)
          merged.push(path)
          continue
        }
        if (ours && Buffer.compare(ours, theirs) === 0) continue
        if (!ours || isBinary(ours) || isBinary(theirs)) {
          conflicts.push(path)
          continue
        }
        const base = await this.git(["-C", target.path, "show", `HEAD:${path}`], target.path, 30_000)
        const basePath = join(work, "base")
        const oursTemp = join(work, "ours")
        const theirsTemp = join(work, "theirs")
        await writeFile(basePath, base.code === 0 ? base.stdout : "")
        await writeFile(oursTemp, ours)
        await writeFile(theirsTemp, theirs)
        const result = await this.git(
          ["merge-file", "-p", "--diff3", oursTemp, basePath, theirsTemp],
          target.path,
          60_000,
        )
        if (result.code === 0 || result.code === 1) {
          await writeFile(oursPath, result.stdout)
          if (result.code === 1) conflicts.push(path)
          else merged.push(path)
        } else {
          conflicts.push(path)
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
    return {
      merged,
      conflicts,
      output: `merged ${merged.length}; conflicts ${conflicts.length}${conflicts.length > 0 ? `: ${conflicts.join(", ")}` : ""}`,
    }
  }

  /** Stage every change in this worktree and create one checkpoint commit. */
  async commit(workspace: Workspace, message: string): Promise<{ hash: string; output: string }> {
    await this.git(["-C", workspace.path, "add", "-A", "--", ".", ":(exclude)node_modules"], workspace.path, 30_000)
    const commit = await this.git(
      [
        "-c",
        "user.name=Arena",
        "-c",
        "user.email=arena@local",
        "-C",
        workspace.path,
        "commit",
        "-m",
        message.trim() || "arena checkpoint",
      ],
      workspace.path,
      60_000,
    )
    const head = await this.git(["-C", workspace.path, "rev-parse", "--short", "HEAD"], workspace.path, 15_000)
    return {
      hash: head.stdout.trim(),
      output: trim(`${commit.stdout}\n${commit.stderr}`),
    }
  }

  async log(workspace: Workspace, limit = 10): Promise<string> {
    const result = await this.git(
      ["-C", workspace.path, "log", `-n${Math.max(1, Math.min(50, limit))}`, "--oneline", "--decorate"],
      workspace.path,
      30_000,
    )
    return trim(result.stdout || result.stderr)
  }

  /**
   * Branch-level merge for review. It stops before the merge commit so the
   * integrator can inspect the diff and run the verification command. A dirty
   * target is refused rather than merged over.
   */
  async mergeBranch(
    target: Workspace,
    sourceBranch: string,
    message: string,
  ): Promise<{ ok: boolean; conflicts: string[]; output: string }> {
    if (!/^[A-Za-z0-9._/-]+$/.test(sourceBranch)) {
      return { ok: false, conflicts: [], output: `invalid branch name: ${sourceBranch}` }
    }
    const status = await this.git(["-C", target.path, "status", "--porcelain"], target.path, 30_000)
    if (status.stdout.trim().length > 0) {
      return { ok: false, conflicts: [], output: "the target worktree has uncommitted changes; commit or discard them first" }
    }
    const merge = await this.git(
      ["-C", target.path, "merge", "--no-ff", "--no-commit", sourceBranch],
      target.path,
      120_000,
    )
    const conflicted = await this.git(
      ["-C", target.path, "diff", "--name-only", "--diff-filter=U"],
      target.path,
      30_000,
    )
    const conflicts = conflicted.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (conflicts.length > 0 || merge.code !== 0) {
      return {
        ok: false,
        conflicts,
        output: trim(`${merge.stdout}\n${merge.stderr}\n${conflicts.length > 0 ? `conflicts: ${conflicts.join(", ")}` : ""}`),
      }
    }
    return {
      ok: true,
      conflicts: [],
      output: trim(`${merge.stdout}\n${merge.stderr}\nReady to verify and commit: ${message}`),
    }
  }

  async abortMerge(workspace: Workspace): Promise<string> {
    const result = await this.git(["-C", workspace.path, "merge", "--abort"], workspace.path, 30_000)
    return trim(result.stdout || result.stderr || "merge aborted")
  }

  async resolve(workspace: Workspace, paths: string[], take: "ours" | "theirs"): Promise<string> {
    const clean = paths.map((path) => path.trim()).filter(Boolean)
    if (clean.length === 0) return "resolve needs at least one path"
    if (clean.some((path) => path.includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path))) {
      return "resolve refuses a path outside the worktree"
    }
    const checkout = await this.git(
      ["-C", workspace.path, "checkout", `--${take}`, "--", ...clean],
      workspace.path,
      30_000,
    )
    const add = await this.git(["-C", workspace.path, "add", "--", ...clean], workspace.path, 30_000)
    return trim(`${checkout.stdout}\n${checkout.stderr}\n${add.stdout}\n${add.stderr}\nresolved ${clean.length} path(s) with ${take}`)
  }

  async verify(
    workspace: Workspace,
    command: string | undefined,
    label: string,
    timeoutMs: number,
    metricPattern?: RegExp,
  ): Promise<VerificationResult> {
    if (!command || command.trim().length === 0) {
      return { label, exitCode: 0, output: "no verification command", durationMs: 0, passed: true, skipped: "no verification command" }
    }
    const started = Date.now()
    try {
      const result = await execShell(command, {
        cwd: workspace.path,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      })
      const output = trim(`${result.stdout}\n${result.stderr}`)
      const metric = metricPattern ? Number(metricPattern.exec(result.stdout)?.[1]) : undefined
      return {
        label,
        command,
        cwd: workspace.path,
        exitCode: 0,
        output,
        durationMs: Date.now() - started,
        passed: true,
        metric: Number.isFinite(metric) ? metric : undefined,
      }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string }
      return {
        label,
        command,
        cwd: workspace.path,
        exitCode: typeof failure.code === "number" ? failure.code : failure.killed ? 124 : 1,
        output: trim(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.killed ? "timed out" : ""}`),
        durationMs: Date.now() - started,
        passed: false,
      }
    }
  }
}
