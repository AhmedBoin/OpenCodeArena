/**
 * Prior memory: what the last field on the same objective already established.
 *
 * A prior fact is `assumed`, never `verified`. It is there so the new crew tests
 * the delta instead of re-deriving the same answer for twenty minutes.
 */

import type { Fact, FieldReport } from "../types.ts"
import type { FieldState } from "./field.ts"

export interface PriorFact {
  claim: string
  area?: string
  evidence?: string[]
}

export interface PriorMemory {
  objective: string
  runID: string
  at: number
  facts: PriorFact[]
  routes: string[]
  outcome?: FieldReport["outcome"]
}

/** Stable, short key for an objective; FNV-1a is enough for a KV bucket. */
export function objectiveKey(objective: string): string {
  const text = objective.toLowerCase().replace(/\s+/g, " ").trim()
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `arena:objective/${(hash >>> 0).toString(16)}`
}

export function priorFromReport(input: {
  objective: string
  runID: string
  at: number
  report: FieldReport
  facts: readonly Fact[]
}): PriorMemory {
  const facts: PriorFact[] = []
  for (const fact of input.facts) {
    if (fact.status === "superseded" || fact.claim.trim().length === 0) continue
    facts.push({ claim: fact.claim, area: fact.area, evidence: fact.evidence.slice(0, 3) })
    if (facts.length >= 8) break
  }
  for (const line of input.report.proven.slice(0, 4)) {
    if (facts.some((fact) => fact.claim === line)) continue
    facts.push({ claim: line })
  }
  return {
    objective: input.objective,
    runID: input.runID,
    at: input.at,
    facts: facts.slice(0, 10),
    routes: input.report.nextRoutes.slice(0, 6),
    outcome: input.report.outcome,
  }
}

/** Seed the board with assumed facts. They never outrank an observed fact. */
export function seedPrior(state: FieldState, prior: PriorMemory | undefined, now: number): FieldState {
  if (!prior || prior.facts.length === 0) return state
  const next = structuredClone(state)
  const existing = new Set((next.facts ?? []).map((fact) => fact.claim.toLowerCase().trim()))
  const facts: Fact[] = []
  for (const [index, fact] of prior.facts.entries()) {
    const claim = fact.claim.replace(/\s+/g, " ").trim()
    if (claim.length === 0 || existing.has(claim.toLowerCase())) continue
    existing.add(claim.toLowerCase())
    facts.push({
      id: `p${index + 1}`,
      author: "prior",
      claim,
      evidence: [...(fact.evidence ?? [])],
      area: fact.area,
      status: "assumed",
      basedOn: [],
      at: now,
    })
    if (facts.length >= 6) break
  }
  if (facts.length === 0) return state
  next.facts = [...facts, ...(next.facts ?? [])]
  next.prior = { runID: prior.runID, objective: prior.objective, at: prior.at, facts: facts.length, routes: prior.routes }
  return next
}

export function priorLine(state: FieldState): string {
  const prior = state.prior
  if (!prior || prior.facts === 0) return ""
  const route = prior.routes[0] ? `; top remaining route: ${prior.routes[0]}` : ""
  return `PRIOR ${prior.facts} assumed fact(s) from ${prior.runID}: do not re-derive, test the delta${route}`
}
