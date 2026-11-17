/**
 * The state card: the first thing every agent reads, and the only place the
 * current truth is allowed to live. Pure data; the driver decides where it goes.
 *
 * The card is capped at 18 lines and 1,400 characters. Everything else is one
 * `arena read` away. If a fact cannot fit here, it is not yet the state.
 */

import { activeIntents, memberOf, type FieldMember, type FieldState } from "./field.ts"
import type { Fact, Oracle } from "../types.ts"

const CARD_LINES = 18
const CARD_CHARS = 1_400

function short(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function isObserved(fact: Fact): boolean {
  return (
    fact.status === "observed" ||
    fact.status === "verified" ||
    (fact.status === "proposed" && (fact.evidence ?? []).length > 0)
  )
}

function oracleLine(oracle: Oracle | undefined): string {
  if (!oracle) return "ORACLE  unset: recon must name one observable before any test"
  const state = oracle.confirmed === true ? "confirmed" : "unconfirmed: capture the baseline"
  return `ORACLE  ${state}: ${short(oracle.observable, 110)}`
}

function nowLine(state: FieldState, now: number): string {
  const running = (state.experiments ?? []).filter((experiment) => experiment.status === "running")
  if (running.length > 0) {
    const first = running[0]!
    const elapsed = clock(Math.max(0, now - (first.startedAt ?? now)))
    const more = running.length > 1 ? ` (+${running.length - 1} more)` : ""
    return `NOW     ${first.id} ${first.owner} ${elapsed}${more}, expect: ${short(first.expect, 90)}`
  }
  const nextQueued = (state.experiments ?? []).find((experiment) => experiment.status === "queued")
  if (nextQueued) return `NOW     ${nextQueued.id} queued for ${nextQueued.owner}, expect: ${short(nextQueued.expect, 80)}`
  return "NOW     no experiment running"
}

function nextLine(state: FieldState, member: FieldMember | undefined, now: number): string {
  if (!state.oracle) return "NEXT    recon: name the pass/fail observable and capture the baseline"
  if (state.oracle.confirmed !== true) return "NEXT    recon: capture the baseline and post kind=oracle"
  const running = (state.experiments ?? []).filter((experiment) => experiment.status === "running")
  const mine = running.find((experiment) => experiment.owner === member?.label)
  if (mine) return `NEXT    run it, then post kind=result test=${mine.id} pass|fail|invalid`
  if (running.length > 0) {
    return `NEXT    ${running[0]!.owner} is running ${running[0]!.id}; test a different resource or wait for that one`
  }
  return "NEXT    post kind=test with one command and one expected observation"
}

/** The 18-line card every prompt starts with. */
export function stateCard(state: FieldState, me: string, now: number, health?: string): string {
  const member = memberOf(state, me)
  const budget = state.deadlineAt > 0 ? Math.max(1, state.deadlineAt - state.startedAt) : 0
  const used = Math.max(0, now - state.startedAt)
  const facts = (state.facts ?? []).filter((fact) => fact.status !== "superseded")
  const allObserved = facts.filter(isObserved)
  const observed = allObserved.slice(-3)
  const refuted = facts.filter((fact) => fact.status === "refuted").slice(-2)
  const assumed = facts.filter((fact) => fact.status === "assumed").slice(-1)
  const contested = facts.filter((fact) => fact.status === "contested")
  const lines: string[] = []

  const crew = state.members.length
  lines.push(
    `ARENA ${state.id}  ${clock(used)}${budget > 0 ? ` / ${clock(budget)}` : " · live"}  ${state.coordination ?? "split"}  ${crew} agent(s)`,
  )
  lines.push(`GOAL    ${short(state.contract.objective, 120)}`)
  lines.push(oracleLine(state.oracle))

  const counts = `${allObserved.length} observed | ${refuted.length} refuted | ${contested.length} contested`
  lines.push(`TRUTH   ${counts}`)
  for (const fact of observed.slice(-2)) lines.push(`  + ${short(fact.claim, 100)}  (${fact.id})`)
  for (const fact of refuted.slice(-2)) lines.push(`  - ${short(fact.claim, 100)}  (${fact.id})`)
  if (assumed.length > 0) lines.push(`  ~ prior: ${short(assumed[0]!.claim, 96)}  (${assumed[0]!.id})`)
  if (contested.length > 0) lines.push(`  ! contested: ${short(contested[0]!.claim, 92)}  (${contested[0]!.id})`)

  const lane = member?.workstream
  lines.push(
    lane
      ? `LANE    ${lane.name} (${lane.kind}); you own ${short(lane.owns.join(", ") || "the named area", 80)}`
      : "LANE    independent; whole problem, no lane",
  )
  // In copy-on-write only launches share a host resource. A write lease is
  // private to the worktree and should not distract the crew.
  const leases = activeIntents(state, now).filter(
    (intent) => intent.kind === "launch" || (intent.kind === "write" && state.copyOnWrite !== true),
  )
  if (leases.length > 0) {
    const mine = leases.find((intent) => intent.owner === me)
    lines.push(
      `LEASE   ${mine ? `you: ${short(mine.area, 70)}` : `${leases[0]!.owner}: ${short(leases[0]!.area, 70)}`}${
        leases.length > 1 ? ` (+${leases.length - 1})` : ""
      }`,
    )
  }
  lines.push(nowLine(state, now))
  lines.push(nextLine(state, member, now))

  if (health && health.length > 0) lines.push(`HEALTH  ${short(health, 110)}`)
  const openArb = (state.arbitrations ?? []).find((entry) => entry.status === "open")
  if (openArb) lines.push(`BLOCK   arbitration ${openArb.id} for ${openArb.owner}: ${short(openArb.test, 80)}`)
  else lines.push("BLOCK   none")

  return lines.slice(0, CARD_LINES).join("\n").slice(0, CARD_CHARS)
}

/**
 * A compact update for a seat that already holds the full card. The stable
 * lines are repeated; the long goal/truth detail is not.
 */
export function deltaCard(state: FieldState, me: string, now: number, delta: string, health?: string): string {
  const keep = stateCard(state, me, now, health)
    .split("\n")
    .filter((line) => /^(?:ARENA|ORACLE|TRUTH|NEXT|BLOCK|HEALTH|  [+!~-])/.test(line))
  return [keep.join("\n"), delta].filter((part) => part.length > 0).join("\n\n")
}

/** The card plus at most six new room lines. Used by every worker prompt. */
export function cardWithDelta(state: FieldState, me: string, now: number, delta: string, limit = 6): string {
  const lines = delta
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
  return [stateCard(state, me, now), lines.length > 0 ? `\nUPDATES\n${lines.join("\n")}` : ""].join("\n")
}
