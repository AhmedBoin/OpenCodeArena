/**
 * A finished Arena agent is sealed. No room traffic, mention expiry, nudge,
 * coordinator digest or fresh resume may prompt it again. A `left` seal is
 * permanent: only a fresh field/session can bring that work back.
 *
 * The registry lives on `globalThis` because a plugin hot reload replaces the
 * service instance while old driver loops may still be finishing a turn. A
 * per-instance set would let an old driver wake a sealed session.
 */

export type SealReason = "left" | "done" | "stopped" | "failed" | "field-closed"

export interface SealEntry {
  label: string
  runID: string
  reason: SealReason
  at: number
}

const MAX_SEALS = 2_000

function registry(): Map<string, SealEntry> {
  const shared = globalThis as typeof globalThis & { __opencodeArenaSeals?: Map<string, SealEntry> }
  shared.__opencodeArenaSeals ??= new Map()
  return shared.__opencodeArenaSeals
}

export function sealSession(sessionID: string, input: { label: string; runID: string; reason: SealReason; at: number }): void {
  if (!sessionID) return
  const seals = registry()
  seals.set(sessionID, { label: input.label, runID: input.runID, reason: input.reason, at: input.at })
  if (seals.size > MAX_SEALS) {
    const oldest = seals.keys().next().value
    if (typeof oldest === "string") seals.delete(oldest)
  }
}

export function unsealSession(sessionID: string): void {
  if (!sessionID) return
  // A leave is permanent. Only a fresh field/session can bring the work back.
  if (registry().get(sessionID)?.reason === "left") return
  registry().delete(sessionID)
}

export function sealOf(sessionID: string): SealEntry | undefined {
  return registry().get(sessionID)
}

export function isSealed(sessionID: string): boolean {
  return registry().has(sessionID)
}

/** Test-only: a fresh process has an empty seal registry. */
export function resetSeals(): void {
  registry().clear()
}
