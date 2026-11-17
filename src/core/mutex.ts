/**
 * Cross-process lock for an Arena run. It uses only an exclusive file create
 * (`wx`), so it needs no external tool, works on Windows and POSIX, and is
 * released in a `finally` block. A lock older than the TTL is treated as a
 * crashed holder and removed once.
 */

import { mkdir, open, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export class LockTimeout extends Error {}

const SLEEP_MS = 40

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function runLockPath(runID: string): string {
  // The key can be a run or a run-scoped resource (`run:file:src/app.ts`).
  // Encode it so a separator or drive letter cannot escape the lock directory.
  const safe = encodeURIComponent(runID).replace(/%/g, "_").replace(/\*/g, "_2A").slice(0, 180)
  return join(tmpdir(), "arena", "locks", `${safe}.lock`)
}

/** A lock key for one resource inside a field. */
export function resourceLockKey(runID: string, resource: string): string {
  return `${runID}:${resource.trim().toLowerCase()}`
}

export async function withRunLock<T>(runID: string, fn: () => Promise<T>, timeoutMs = 30_000, ttlMs = 30 * 60_000): Promise<T> {
  const path = runLockPath(runID)
  await mkdir(join(tmpdir(), "arena", "locks"), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(path, "wx")
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
        return await fn()
      } finally {
        await handle.close().catch(() => undefined)
        await unlink(path).catch(() => undefined)
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== "EEXIST") throw error
      const info = await stat(path).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > ttlMs) {
        await unlink(path).catch(() => undefined)
        continue
      }
      if (Date.now() - started > timeoutMs) throw new LockTimeout(`Arena run ${runID} is busy`)
      await sleep(SLEEP_MS)
    }
  }
}
