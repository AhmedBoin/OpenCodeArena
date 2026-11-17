/**
 * Field report assembly — what a run actually proved, what it did not, and the
 * routes that remain.
 *
 * Pure data: the state is only read, never changed, and every optional array is
 * tolerated. The host calls this when a field stops (deadline, reported,
 * accepted) or when the coordinator asks for a summary, so it must stay cheap
 * and total — no input may make it throw.
 */

import type { Fact, FieldReport, HypothesisRecord } from "../types.ts"
import type { FieldState } from "./field.ts"

const ARTIFACT_LIMIT = 20
const ROUTE_LIMIT = 10

/** A path may open with a drive letter, a POSIX root, or a UNC root. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/

function isOpen(hypothesis: HypothesisRecord): boolean {
  return hypothesis.status === "open" || hypothesis.status === "testing"
}

function testOf(hypothesis: HypothesisRecord): string {
  return (hypothesis.test ?? "").trim()
}

/** One unproven line: the statement plus the test that would settle it. */
function unprovenLine(hypothesis: HypothesisRecord): string {
  const test = testOf(hypothesis)
  return `${hypothesis.statement} (test: ${test.length > 0 ? test : "none"})`
}

/** One route: the test to run, falling back to the statement it would settle. */
function routeLine(hypothesis: HypothesisRecord): string {
  const test = testOf(hypothesis)
  return test.length > 0 ? test : hypothesis.statement
}

/**
 * A claim is accepted when the record says so, or implicitly when the field was
 * closed as accepted (the gate accepts the claim it was judging, normally the
 * newest one). Older claims in a long field must not turn into proven lines.
 */
function acceptedClaimTexts(state: FieldState): string[] {
  const claims = state.claims ?? []
  const flagged = claims.filter((claim) => (claim as { accepted?: unknown }).accepted === true)
  if (flagged.length > 0) return flagged.map((claim) => claim.text)
  if (state.closed?.decision === "accepted" && claims.length > 0) {
    const newest = claims[claims.length - 1]
    return newest ? [newest.text] : []
  }
  return []
}

function isObserved(fact: Fact): boolean {
  return (
    fact.status === "observed" ||
    fact.status === "verified" ||
    (fact.status === "proposed" && (fact.evidence ?? []).length > 0)
  )
}

function outcomeOf(state: FieldState, accepted: readonly string[], hypotheses: readonly HypothesisRecord[]): FieldReport["outcome"] {
  if (state.closed?.decision === "accepted" || accepted.length > 0) return "accepted"
  const facts = state.facts ?? []
  const refuted = facts.filter((fact) => fact.status === "refuted")
  const openExperiment = (state.experiments ?? []).some(
    (experiment) => experiment.status === "running" || experiment.status === "queued",
  )
  // An empty field is not a negative result; there was no hypothesis to refute.
  if (hypotheses.length > 0 && hypotheses.every((hypothesis) => hypothesis.status === "refuted" || hypothesis.status === "stale")) {
    return "negative"
  }
  // A field that closed every route it opened is negative even when nobody
  // posted a formal hypothesis. This is the Acrobat shape: facts plus dead ends.
  if (!openExperiment && refuted.length > 0 && !hypotheses.some(isOpen)) return "negative"
  if (state.stopReason === "reported" && !hypotheses.some(isOpen) && !openExperiment) return "negative"
  return "inconclusive"
}

function looksLikePath(value: string): boolean {
  const text = value.trim()
  if (text.length === 0) return false
  if (text.startsWith("/")) return true
  if (text.startsWith("\\\\")) return true
  if (DRIVE_PATH.test(text)) return true
  return text.includes("\\") && EXTENSION.test(text)
}

function artifactsOf(state: FieldState): string[] {
  const seen = new Set<string>()
  const artifacts: string[] = []
  const evidence: string[] = []
  for (const fact of state.facts ?? []) evidence.push(...(fact.evidence ?? []))
  for (const claim of state.claims ?? []) evidence.push(...(claim.evidence ?? []))
  if (typeof state.closed?.evidence === "string") evidence.push(state.closed.evidence)

  for (const raw of evidence) {
    const value = raw.trim()
    if (!looksLikePath(value) || seen.has(value)) continue
    seen.add(value)
    artifacts.push(value)
    if (artifacts.length >= ARTIFACT_LIMIT) break
  }
  return artifacts
}

function routesOf(outcome: FieldReport["outcome"], state: FieldState, hypotheses: readonly HypothesisRecord[]): string[] {
  const routes = hypotheses.filter((hypothesis) => hypothesis.status === "open").map(routeLine)
  for (const experiment of state.experiments ?? []) {
    if (experiment.status === "queued" || experiment.status === "running") {
      routes.push(`${experiment.id}: ${experiment.expect}`)
    }
  }
  for (const route of state.prior?.routes ?? []) {
    if (route.trim().length > 0) routes.push(route)
  }
  // A negative report still points at whatever was never closed out: a supported
  // hypothesis is not a route yet, so its test is the remaining work.
  if (outcome === "negative") {
    for (const hypothesis of hypotheses) {
      if (hypothesis.status === "refuted" || hypothesis.status === "stale") continue
      routes.push(`test the remaining route: ${routeLine(hypothesis)}`)
    }
  }
  return [...new Set(routes)].slice(0, ROUTE_LIMIT)
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function reasonOf(input: {
  outcome: FieldReport["outcome"]
  accepted: readonly string[]
  observed: readonly string[]
  refuted: readonly string[]
  hypotheses: readonly HypothesisRecord[]
}): string {
  if (input.accepted.length > 0) {
    const claim = input.accepted[0]?.trim()
    return claim && claim.length > 0 ? `accepted: ${claim}` : "accepted"
  }
  if (input.outcome === "accepted") return "accepted"

  const open = input.hypotheses.filter((hypothesis) => hypothesis.status === "open").length
  const parts: string[] = []
  if (input.observed.length > 0) parts.push(counted(input.observed.length, "observed fact", "observed facts"))
  if (input.refuted.length > 0) parts.push(counted(input.refuted.length, "refuted route", "refuted routes"))
  if (open > 0) parts.push(counted(open, "open route", "open routes"))
  if (parts.length > 0) return parts.join(", ")
  return input.outcome === "negative" ? "no accepted claim; no open route" : "nothing proven yet"
}

/** Summarize a field: outcome, proven and unproven lines, artifacts, next routes. */
export function buildReport(state: FieldState): FieldReport {
  const facts = state.facts ?? []
  const hypotheses = state.hypotheses ?? []
  const accepted = acceptedClaimTexts(state).filter((text) => text.trim().length > 0)
  const outcome = outcomeOf(state, accepted, hypotheses)

  const observed = facts.filter(isObserved).map((fact) => `${fact.author}: ${fact.claim}`)
  const refutedFacts = facts.filter((fact) => fact.status === "refuted").map((fact) => `${fact.author}: ${fact.claim}`)
  const proven: string[] = [...observed]
  for (const text of accepted) proven.push(text)

  const unproven: string[] = []
  for (const hypothesis of hypotheses) {
    if (isOpen(hypothesis)) unproven.push(unprovenLine(hypothesis))
  }
  for (const fact of facts) {
    if (fact.status === "contested") unproven.push(`contested: ${fact.claim}`)
  }
  for (const experiment of state.experiments ?? []) {
    if (experiment.status === "running" || experiment.status === "queued") {
      unproven.push(`${experiment.id} (${experiment.owner}): ${experiment.hypothesis}`)
    }
  }

  const baseReason = reasonOf({ outcome, accepted, observed, refuted: refutedFacts, hypotheses })
  const note = state.notes?.at(-1)?.trim()
  return {
    outcome,
    proven: [...new Set(proven)],
    unproven: [...new Set(unproven)],
    artifacts: artifactsOf(state),
    nextRoutes: routesOf(outcome, state, hypotheses),
    reason: note && outcome !== "accepted" ? `${note} (${baseReason})` : baseReason,
    observed: [...new Set(observed)],
    refuted: [...new Set(refutedFacts)],
  }
}
