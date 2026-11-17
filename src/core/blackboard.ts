/**
 * The structured blackboard: facts, hypotheses and arbitration.
 *
 * Pure data only, like `core/field.ts`: callers pass `now` and receive a new
 * `FieldState`. A contradiction becomes one decisive arbitration test instead
 * of another round of prose.
 */

import type { Arbitration, Fact, FactStatus } from "../types.ts"
import type { FieldMember, FieldState } from "./field.ts"

/** One arbitration gets two minutes to settle. */
const ARBITRATION_WINDOW_MS = 120_000

/** Roles that are good at deciding a contested fact, in preference order. */
const PREFERRED_ROLES = ["adversary", "verifier", "analyst"]

/**
 * Evidence that names something executable or observable is a concrete test.
 * A bare note such as "dump" is not; an API name or a command is.
 */
const CONCRETE_TEST =
  /\b(?:readprocessmemory|writeprocessmemory|bun|npm|pnpm|yarn|node|deno|python3?|pytest|cargo|dotnet|javac?|gcc|clang|rg|grep|sed|awk|curl|wget|xxd|od|objdump|strings|dumpbin|tasklist|taskkill|powershell|pwsh|bash)\b|`[^`]+`|[A-Za-z]:[\\/][^\s]+\.(?:exe|dll|sys|sh|bat|cmd|ps1|py|js|ts)\b/i

function clone(state: FieldState): FieldState {
  return structuredClone(state)
}

function findFact(state: FieldState, id: string): Fact | undefined {
  return (state.facts ?? []).find((fact) => fact.id === id)
}

function areaOf(fact: Fact): string {
  return fact.area?.trim().toLowerCase() ?? ""
}

function claimOf(fact: Fact): string {
  return fact.claim.replace(/\s+/g, " ").trim().toLowerCase()
}

function statusOpposite(left: Fact, right: Fact): boolean {
  return (
    (left.status === "verified" && right.status === "refuted") ||
    (left.status === "refuted" && right.status === "verified")
  )
}

function claimsDiffer(left: Fact, right: Fact): boolean {
  const leftClaim = claimOf(left)
  const rightClaim = claimOf(right)
  return leftClaim.length > 0 && rightClaim.length > 0 && leftClaim !== rightClaim
}

/** Two facts oppose when they cover the same area and disagree or have opposite outcomes. */
function opposes(left: Fact, right: Fact): boolean {
  if (left.id === right.id) return false
  if (left.status === "superseded" || right.status === "superseded") return false
  const area = areaOf(left)
  if (area.length === 0 || area !== areaOf(right)) return false
  return statusOpposite(left, right) || claimsDiffer(left, right)
}

function opponentsOf(state: FieldState, fact: Fact): Fact[] {
  return (state.facts ?? []).filter((entry) => opposes(fact, entry))
}

function roleText(member: FieldMember): string {
  return `${member.stance.name} ${member.stance.id} ${member.agent}`.toLowerCase()
}

/** The first member who authored neither fact, preferring an adversarial role. */
function pickOwner(state: FieldState, left: Fact, right: Fact): string {
  const neutral = state.members.filter(
    (member) => member.label !== left.author && member.label !== right.author,
  )
  for (const role of PREFERRED_ROLES) {
    const preferred = neutral.find((member) => roleText(member).includes(role))
    if (preferred) return preferred.label
  }
  const first = neutral[0]
  if (first) return first.label
  return state.members[0]?.label ?? "field"
}

function concreteTest(fact: Fact): string | undefined {
  return fact.evidence.map((entry) => entry.trim()).find((entry) => entry.length > 0 && CONCRETE_TEST.test(entry))
}

/** One check that distinguishes the two claims, using real evidence when available. */
function buildTest(left: Fact, right: Fact): string {
  const concrete = concreteTest(left) ?? concreteTest(right)
  if (concrete) return concrete
  return `Run one decisive check: "${left.claim}" vs "${right.claim}".`
}

function arbitrationID(state: FieldState, left: Fact, right: Fact): string {
  const base = `arb_${left.id}_${right.id}`
  const existing = state.arbitrations ?? []
  if (!existing.some((arbitration) => arbitration.id === base)) return base
  let suffix = 2
  while (existing.some((arbitration) => arbitration.id === `${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function startsWithID(result: string, id: string): boolean {
  if (id.length === 0) return false
  const text = result.trimStart()
  if (!text.startsWith(id)) return false
  const rest = text.slice(id.length)
  const next = rest[0]
  return next === undefined || !/[A-Za-z0-9_-]/.test(next)
}

/** Append a fact. An explicit contradiction only contests the pair; arbitration comes later. */
export function proposeFact(
  state: FieldState,
  input: {
    id: string
    author: string
    claim: string
    evidence: string[]
    area?: string
    status?: FactStatus
    basedOn?: string[]
    contradicts?: string[]
    at: number
  },
): FieldState {
  if (findFact(state, input.id)) return state

  const fact: Fact = {
    id: input.id,
    author: input.author,
    claim: input.claim,
    evidence: [...input.evidence],
    area: input.area,
    status: input.status ?? "proposed",
    basedOn: [...(input.basedOn ?? [])],
    contradicts: input.contradicts ? [...input.contradicts] : undefined,
    at: input.at,
  }

  const next = clone(state)
  const contradicted = new Set(fact.contradicts ?? [])
  if (contradicted.size > 0) {
    for (const existing of next.facts ?? []) {
      if (contradicted.has(existing.id)) {
        existing.status = "contested"
        fact.status = "contested"
      }
    }
  }
  next.facts = [...(next.facts ?? []), fact]
  return next
}

/** Mark a fact contested and, when exactly one rival exists, open the deciding test. */
export function contestFact(state: FieldState, input: { id: string; by: string; at: number }): FieldState {
  const fact = findFact(state, input.id)
  if (!fact) return state

  const rivals = opponentsOf(state, fact)
  const next = rivals.length === 1 ? openArbitration(state, { id: input.id, at: input.at }) : state
  const target = next.facts?.find((entry) => entry.id === input.id)
  if (!target || target.status === "contested") return next

  const cloned = clone(next)
  const contested = cloned.facts?.find((entry) => entry.id === input.id)
  if (!contested) return next
  contested.status = "contested"
  return cloned
}

/**
 * Create one open arbitration for a contested pair. If several rivals exist,
 * an explicit `contradicts` link wins; otherwise the first rival is used.
 */
export function openArbitration(state: FieldState, input: { id: string; at: number }): FieldState {
  const facts = state.facts ?? []
  const target = facts.find((fact) => fact.id === input.id)
  if (!target) return state

  const rivals = opponentsOf(state, target)
  if (rivals.length === 0) return state
  const linked = rivals.filter(
    (rival) => (target.contradicts ?? []).includes(rival.id) || (rival.contradicts ?? []).includes(target.id),
  )
  const rival = linked[0] ?? rivals[0]
  if (!rival) return state

  let first = target
  let second = rival
  if (facts.indexOf(first) > facts.indexOf(second)) {
    first = rival
    second = target
  }

  const alreadyOpen = (state.arbitrations ?? []).some(
    (arbitration) =>
      arbitration.status === "open" &&
      arbitration.factIDs.includes(first.id) &&
      arbitration.factIDs.includes(second.id),
  )
  if (alreadyOpen) return state

  const next = clone(state)
  const arbitration: Arbitration = {
    id: arbitrationID(state, first, second),
    factIDs: [first.id, second.id],
    test: buildTest(first, second),
    owner: pickOwner(state, first, second),
    deadlineAt: input.at + ARBITRATION_WINDOW_MS,
    status: "open",
  }
  next.arbitrations = [...(next.arbitrations ?? []), arbitration]
  return next
}

/**
 * Resolve an arbitration. A result starting with one fact id wins; anything
 * else is ambiguous and supersedes both claims.
 */
export function resolveArbitration(
  state: FieldState,
  input: { id: string; result: string; at: number },
): FieldState {
  const current = (state.arbitrations ?? []).find((arbitration) => arbitration.id === input.id)
  if (!current || current.status !== "open") return state

  const next = clone(state)
  const arbitration = (next.arbitrations ?? []).find((entry) => entry.id === input.id)
  if (!arbitration) return state

  const matches = arbitration.factIDs.filter((id) => startsWithID(input.result, id))
  arbitration.status = "resolved"
  arbitration.result = input.result

  const winner = matches.length === 1 ? matches[0] : undefined
  for (const id of arbitration.factIDs) {
    const fact = (next.facts ?? []).find((entry) => entry.id === id)
    if (!fact) continue
    fact.status = winner === undefined ? "superseded" : id === winner ? "verified" : "refuted"
  }
  return next
}

/**
 * Propagate a refuted fact: direct dependants are superseded and open
 * hypotheses whose test names the fact go stale.
 */
export function markStale(state: FieldState, factID: string): FieldState {
  if (factID.trim().length === 0) return state

  const needsFactChange = (state.facts ?? []).some(
    (fact) => fact.basedOn.includes(factID) && fact.status !== "superseded",
  )
  const needsHypothesisChange = (state.hypotheses ?? []).some(
    (hypothesis) => hypothesis.status === "open" && hypothesis.test.includes(factID),
  )
  if (!needsFactChange && !needsHypothesisChange) return state

  const next = clone(state)
  for (const fact of next.facts ?? []) {
    if (fact.basedOn.includes(factID)) fact.status = "superseded"
  }
  for (const hypothesis of next.hypotheses ?? []) {
    if (hypothesis.status === "open" && hypothesis.test.includes(factID)) hypothesis.status = "stale"
  }
  return next
}
