/**
 * Fencing leases for a shared workspace.
 *
 * A lease is not advice. A write or launch must present a token that is still
 * active, still owned by the caller, and still covers the path. Two processes
 * cannot own the same resource at the same time.
 */

import type { FieldState, FieldIntent } from "./field.ts"

export type LeaseKind = "read" | "write" | "launch"

export interface LeaseConflict {
  owner: string
  area: string
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase()
}

function pathsOf(intent: FieldIntent): string[] {
  const explicit = (intent.paths ?? []).map(normalizePath).filter(Boolean)
  if (explicit.length > 0) return explicit
  const area = normalizePath(intent.area)
  return area.length > 0 ? [area] : []
}

function overlap(left: string, right: string): boolean {
  if (left === right) return true
  return left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`)
}

function conflicts(left: FieldIntent, right: FieldIntent, copyOnWrite: boolean): boolean {
  if (left.owner === right.owner) return false
  if (left.status !== "active" || right.status !== "active") return false
  // Reads never fence anyone. They can be stale, and the fact board makes that
  // visible; blocking analysis behind a writer would serialize the whole crew.
  if (left.kind === "read" || right.kind === "read") return false
  // In copy-on-write the write target is private to the seat. Two seats editing
  // the same path in different worktrees cannot collide, so a write lease there
  // is pure ceremony. Only two launches of the same host resource must serialize.
  if (copyOnWrite && !(left.kind === "launch" && right.kind === "launch")) return false
  const leftPaths = pathsOf(left)
  const rightPaths = pathsOf(right)
  if (leftPaths.length === 0 || rightPaths.length === 0) {
    return left.area.trim().toLowerCase() === right.area.trim().toLowerCase()
  }
  return leftPaths.some((path) => rightPaths.some((other) => overlap(path, other)))
}

function token(): string {
  return `lease_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function grantLease(
  state: FieldState,
  input: {
    owner: string
    area: string
    kind: LeaseKind
    paths: string[]
    now: number
    ttlMs: number
  },
): { state: FieldState; token?: string; conflict?: LeaseConflict } {
  const candidate: FieldIntent = {
    id: token(),
    owner: input.owner,
    area: input.area.trim(),
    kind: input.kind,
    paths: input.paths.map(normalizePath).filter(Boolean),
    token: token(),
    heartbeatAt: input.now,
    note: input.area,
    at: input.now,
    expiresAt: input.now + Math.max(1_000, input.ttlMs),
    status: "active",
  }
  const existing = (state.intents ?? []).filter(
    (intent) => intent.status === "active" && intent.expiresAt > input.now,
  )
  const conflict = existing.find((intent) => conflicts(candidate, intent, state.copyOnWrite === true))
  if (conflict) {
    return { state, conflict: { owner: conflict.owner, area: conflict.area } }
  }
  const intents = [
    ...(state.intents ?? []).map((intent) =>
      intent.status === "active" && intent.expiresAt <= input.now
        ? { ...intent, status: "expired" as const }
        : intent,
    ),
    candidate,
  ].slice(-50)
  return { state: { ...state, intents }, token: candidate.token }
}

export function checkLease(
  state: FieldState,
  input: { token: string; owner: string; now: number; path?: string },
): { ok: boolean; reason?: string } {
  const lease = (state.intents ?? []).find((intent) => intent.token === input.token)
  if (!lease) return { ok: false, reason: "no such lease; post intent first" }
  if (lease.owner !== input.owner) return { ok: false, reason: `lease belongs to ${lease.owner}` }
  if (lease.status !== "active") return { ok: false, reason: `lease is ${lease.status}` }
  if (lease.expiresAt <= input.now) return { ok: false, reason: "lease expired; renew it or hand off" }
  if (input.path) {
    const wanted = normalizePath(input.path)
    const covered = pathsOf(lease).some((path) => overlap(wanted, path))
    if (!covered) return { ok: false, reason: `lease does not cover ${input.path}` }
  }
  return { ok: true }
}

export function heartbeatLease(
  state: FieldState,
  input: { token: string; owner: string; now: number; ttlMs: number },
): FieldState {
  return {
    ...state,
    intents: (state.intents ?? []).map((lease) =>
      lease.token === input.token && lease.owner === input.owner && lease.status === "active"
        ? { ...lease, heartbeatAt: input.now, expiresAt: input.now + Math.max(1_000, input.ttlMs) }
        : lease,
    ),
  }
}

export function releaseLease(
  state: FieldState,
  input: { owner: string; token?: string; area?: string; now: number },
): FieldState {
  const area = normalizePath(input.area ?? "")
  const all = !input.token && area.length === 0
  return {
    ...state,
    intents: (state.intents ?? []).map((lease) => {
      if (lease.owner !== input.owner) return lease
      if (lease.status !== "active") return lease
      if (input.token && lease.token !== input.token) return lease
      if (!all && area) {
        const matchesArea = normalizePath(lease.area) === area
        const matchesPath = pathsOf(lease).some((path) => path === area)
        if (!matchesArea && !matchesPath) return lease
      }
      return { ...lease, status: "released" as const }
    }),
  }
}
