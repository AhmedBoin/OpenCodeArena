/**
 * Git bootstrap. Arena treats git as its version-control engine, but a fresh
 * Windows machine may not have it installed. This module resolves the system git
 * first, then downloads the official MinGit zip into Arena's local tools folder
 * and extracts it with the built-in Windows archiver.
 *
 * No user-installed package manager is required. The download is cached.
 */

import { execFile } from "node:child_process"
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const MAX_FILES = 5_000
const MAX_BYTES = 512 * 1024 * 1024
const SKIP = new Set([".git", "node_modules", ".arena", ".arena-vcs", "dist", "build", ".next", ".cache"])

let resolving: Promise<string> | undefined

async function works(candidate: string): Promise<boolean> {
  try {
    const result = await execFileAsync(candidate, ["--version"], { windowsHide: true, timeout: 15_000 })
    return result.stdout.toLowerCase().includes("git version")
  } catch {
    return false
  }
}

function toolsRoot(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode-arena", "tools", "git")
}

async function findDownloaded(): Promise<string | undefined> {
  const root = toolsRoot()
  const candidates = [
    join(root, "git", "cmd", "git.exe"),
    join(root, "cmd", "git.exe"),
    join(root, "bin", "git.exe"),
    join(root, "git.exe"),
  ]
  for (const candidate of candidates) {
    if (await works(candidate)) return candidate
  }
  return undefined
}

async function downloadWindowsGit(): Promise<string> {
  const headers = { "User-Agent": "opencode-arena", Accept: "application/vnd.github+json" }
  let url: string | undefined
  try {
    const response = await fetch("https://api.github.com/repos/git-for-windows/git/releases/latest", { headers })
    if (response.ok) {
      const release = (await response.json()) as { assets?: { name?: string; browser_download_url?: string }[] }
      url = release.assets?.find((asset) => /^MinGit-.*-64-bit\.zip$/i.test(asset.name ?? ""))?.browser_download_url
    }
  } catch {
    // Fall through to the pinned mirror below.
  }
  // A pinned fallback keeps a fresh machine usable even if the API is rate-limited.
  url ??= "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip"

  const root = toolsRoot()
  const zip = join(root, "MinGit.zip")
  const extract = join(root, "extract")
  await mkdir(root, { recursive: true })
  await rm(extract, { recursive: true, force: true })
  await mkdir(extract, { recursive: true })

  const response = await fetch(url, { headers: { "User-Agent": "opencode-arena" } })
  if (!response.ok) throw new Error(`Git is not installed and the portable download failed (${response.status}).`)
  const data = Buffer.from(await response.arrayBuffer())
  await (await import("node:fs/promises")).writeFile(zip, data)
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${extract.replace(/'/g, "''")}' -Force`,
    ],
    { windowsHide: true, timeout: 120_000 },
  )
  // MinGit extracts its cmd/ and mingw64/ folders at the top level.
  const direct = join(extract, "cmd", "git.exe")
  if (await works(direct)) {
    const stable = join(root, "git")
    await rm(stable, { recursive: true, force: true }).catch(() => undefined)
    await rename(extract, stable)
    await rm(zip, { force: true }).catch(() => undefined)
    const found = join(stable, "cmd", "git.exe")
    if (await works(found)) return found
  }
  // Some archives have one nested folder; look one level down.
  for (const name of await readdir(extract).catch(() => [] as string[])) {
    const nested = join(extract, name, "cmd", "git.exe")
    if (await works(nested)) {
      const stable = join(root, "git")
      await rm(stable, { recursive: true, force: true }).catch(() => undefined)
      await rename(join(extract, name), stable)
      await rm(zip, { force: true }).catch(() => undefined)
      return join(stable, "cmd", "git.exe")
    }
  }
  throw new Error("Git download completed but git.exe was not found.")
}

/** Resolve a working git executable, downloading MinGit on Windows if needed. */
export function ensureGit(): Promise<string> {
  resolving ??= (async () => {
    if (process.env.ARENA_GIT && (await works(process.env.ARENA_GIT))) return process.env.ARENA_GIT
    if (await works("git")) return "git"
    const downloaded = await findDownloaded()
    if (downloaded) return downloaded
    if (process.platform !== "win32") {
      throw new Error("Git is required for Arena and was not found on PATH. Install git and retry.")
    }
    return downloadWindowsGit()
  })().catch((error) => {
    resolving = undefined
    throw error
  })
  return resolving
}

/** A bounded filtered copy used only to create a fallback shadow repository. */
export async function copyForShadow(root: string, destination: string): Promise<void> {
  const entries: { path: string; absolute: string; bytes: number }[] = []
  const budget = { files: 0, bytes: 0 }
  async function walk(current: string): Promise<void> {
    const list = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of list) {
      if (SKIP.has(entry.name)) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute).catch(() => undefined)
      if (!info) continue
      budget.files += 1
      budget.bytes += info.size
      if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) {
        throw new Error(`workspace is too large for a shadow git repository (${MAX_FILES} files / ${MAX_BYTES} bytes)`)
      }
      entries.push({ path: relative(root, absolute).replace(/\\/g, "/"), absolute, bytes: info.size })
    }
  }
  await walk(root)
  await rm(destination, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const target = join(destination, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(entry.absolute, target)
  }
}
