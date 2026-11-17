/**
 * The field state machine — continuous peers, one goal, no rounds.
 *
 * Pure data only: callers pass `now` and receive a new state. The host-facing
 * driver lives in `src/field/run.ts`; this file stays portable and testable.
 */

import type {
  Arbitration,
  CoordinationMode,
  Experiment,
  Fact,
  FieldReport,
  HypothesisRecord,
  ModelRef,
  Oracle,
  ProblemContract,
  Stance,
  Usage,
  Workstream,
} from "../types.ts"

export type FieldMemberStatus = "joining" | "idle" | "working" | "left" | "done" | "stopped" | "failed"
export type FieldRunStatus = "running" | "paused" | "stopping" | "done" | "failed" | "interrupted"
export type FieldStopReason = "accepted" | "rejected" | "deadline" | "stopped" | "aborted" | "interrupted" | "failed" | "reported" | "all-left"
export type FieldPostKind =
  | "finding"
  | "fact"
  | "hypothesis"
  | "probe"
  | "oracle"
  | "test"
  | "result"
  | "dead-end"
  | "request"
  | "question"
  | "answer"
  | "claim"
  | "status"
  | "verdict"
  | "note"
  | "intent"
  | "handoff"
  | "lesson"
export type FieldClaimDecision = "accepted" | "rejected"
export type MentionStatus = "open" | "answered" | "expired"

/** A named mention that one agent owes another an answer for. */
export interface MentionRequest {
  id: string
  from: string
  to: string
  text: string
  at: number
  replyBy: number
  status: MentionStatus
  answeredBy?: string
  requiresReply: boolean
  /** True when the sender is holding its next turn for this answer. */
  senderWaits: boolean
  /** Pending asks have not reached the target yet and must not expire unseen. */
  delivery?: "pending" | "delivered"
  deliveredAt?: number
}

/** A public, expiring claim on an area of the work. */
export interface FieldIntent {
  id: string
  owner: string
  area: string
  kind?: "read" | "write" | "launch"
  paths?: string[]
  token?: string
  heartbeatAt?: number
  /** For a launch lease: the tracked job and its OS process. */
  jobID?: string
  pid?: number
  note: string
  at: number
  expiresAt: number
  status: "active" | "released" | "expired" | "revoked"
}

/** A reusable one-line lesson an agent contributes to the room. */
export interface FieldLesson {
  label: string
  text: string
  at: number
}

export interface FieldMember {
  label: string
  agent: string
  model?: ModelRef
  stance: Stance
  workstream?: Workstream
  sessionID: string
  status: FieldMemberStatus
  turns: number
  maxTurns: number
  costUSD: number
  tokens: number
  notebook: string
  lastTurnAt?: number
  lastPostAt?: number
  nudges: number
  wrapped: boolean
  /** A left member is permanently sealed: no message, mention or wake can reach it. */
  leftAt?: number
  leftBy?: "self" | "user"
  leftReason?: string
  /** Copy-on-write mode: the shared baseline and this member's writable copy. */
  workspacePath?: string
  workspaceBranch?: string
  workspaceIsolated?: boolean
  workspaceRepoRoot?: string
  workspaceShadow?: boolean
  /** True once this seat has received the full state card in this session. */
  cardSeen?: boolean
}

/** One post-to-seat delivery, kept for the latency/truncation ledger. */
export interface DeliveryRecord {
  id: string
  to: string
  author: string
  kind: string
  sentAt: number
  deliveredAt?: number
  chars: number
  truncated?: boolean
}

export interface FieldClaim {
  label: string
  text: string
  evidence: string[]
  /**
   * A coverage claim names what was proven and what was not. It closes a field
   * honestly when the original objective was broader than the reachable result.
   */
  coverage?: string[]
  attempts: number
  at: number
  /** In a same-role field an accepted solution is shared, not a field close. */
  accepted?: boolean
}

export interface FieldClosed {
  decision: FieldClaimDecision
  reason: string
  evidence: string
  at: number
}

export interface FieldState {
  id: string
  parentSessionID: string
  contract: ProblemContract
  members: FieldMember[]
  foremanSessionID?: string
  foremanTurns: number
  /** 0 means the referee keeps checking until the field closes. */
  maxForemanTurns: number
  status: FieldRunStatus
  stopReason?: FieldStopReason
  startedAt: number
  deadlineAt: number
  lastCheckAt: number
  checkEveryMs: number
  lastRefereeDecision?: "continue" | "pulse" | "report" | "abort"
  lastRefereeAt?: number
  /** Legacy field from the step-based driver; never set by the continuous driver. */
  dormant?: boolean
  lastProgressAt?: number
  progressNotifiedAt?: number
  posts: number
  deadEnds: number
  claims: FieldClaim[]
  mentions?: MentionRequest[]
  intents?: FieldIntent[]
  lessons?: FieldLesson[]
  facts?: Fact[]
  hypotheses?: HypothesisRecord[]
  arbitrations?: Arbitration[]
  experiments?: Experiment[]
  /** Bounded post-to-seat delivery ledger, newest last. */
  deliveries?: DeliveryRecord[]
  oracle?: Oracle
  /** The read-only baseline every agent may inspect in copy-on-write mode. */
  workspaceRoot?: string
  copyOnWrite?: boolean
  /** False when the field was started with network research disabled. */
  allowNetwork?: boolean
  /** "arena" keeps the strict field allowlist; "all" opens host, MCP and browser tools. */
  toolPolicy?: "arena" | "all"
  /** Set when every seat shares one role and works the whole problem. */
  sameRole?: string
  phase?: "run" | "decide"
  prior?: { runID: string; objective: string; at: number; facts: number; routes: string[] }
  coordination?: CoordinationMode
  crewReason?: string
  report?: FieldReport
  orders?: number
  closed?: FieldClosed
  usage: Usage
  notes: string[]
}

export interface OpenFieldInput {
  id: string
  parentSessionID: string
  contract: ProblemContract
  members: {
    label: string
    agent: string
    model?: ModelRef
    stance: Stance
    workstream?: Workstream
    sessionID: string
    workspacePath?: string
    workspaceBranch?: string
    workspaceIsolated?: boolean
    workspaceRepoRoot?: string
    workspaceShadow?: boolean
  }[]
  workspaceRoot?: string
  copyOnWrite?: boolean
  allowNetwork?: boolean
  toolPolicy?: "arena" | "all"
  sameRole?: string
  coordination?: CoordinationMode
  crewReason?: string
  oracle?: Oracle
  prior?: { runID: string; objective: string; at: number; facts: number; routes: string[] }
  now: number
  budgetMs: number
  checkEveryMs: number
  maxTurns: number
  maxForemanTurns: number
  foremanSessionID?: string
}

const NOTEBOOK_LIMIT = 4_000
const MENTION_LIMIT = 100
const MENTION_HISTORY_MS = 10 * 60_000
const INTENT_LIMIT = 50
const LESSON_LIMIT = 20

function clone(state: FieldState): FieldState {
  return structuredClone(state)
}

function appendNotebook(notebook: string, line: string): string {
  const next = notebook.length === 0 ? line : `${notebook}\n${line}`
  if (next.length <= NOTEBOOK_LIMIT) return next
  // Drop whole lines from the front until the notebook fits again.
  let trimmed = next
  while (trimmed.length > NOTEBOOK_LIMIT && trimmed.includes("\n")) {
    trimmed = trimmed.slice(trimmed.indexOf("\n") + 1)
  }
  return trimmed.slice(-NOTEBOOK_LIMIT)
}

/** A compact record of the agent's own work, injected when its session is recreated. */
export function notebookLine(kind: FieldPostKind, text: string): string {
  return `[${kind}] ${text.replace(/\s+/g, " ").trim().slice(0, 400)}`
}

export function openField(input: OpenFieldInput): FieldState {
  const state: FieldState = {
    id: input.id,
    parentSessionID: input.parentSessionID,
    contract: input.contract,
    members: input.members.map((member) => ({
      label: member.label,
      agent: member.agent,
      model: member.model,
      stance: member.stance,
      workstream: member.workstream,
      sessionID: member.sessionID,
      status: "idle",
      turns: 0,
      maxTurns: input.maxTurns,
      costUSD: 0,
      tokens: 0,
      notebook: "",
      nudges: 0,
      wrapped: false,
      cardSeen: false,
      workspacePath: member.workspacePath,
      workspaceBranch: member.workspaceBranch,
      workspaceIsolated: member.workspaceIsolated,
      workspaceRepoRoot: member.workspaceRepoRoot,
      workspaceShadow: member.workspaceShadow,
    })),
    foremanSessionID: input.foremanSessionID,
    foremanTurns: 0,
    maxForemanTurns: input.maxForemanTurns,
    status: "running",
    startedAt: input.now,
    // 0 is a continuous field: no deadline can force anyone out.
    deadlineAt: input.budgetMs > 0 ? input.now + input.budgetMs : 0,
    lastProgressAt: input.now,
    lastCheckAt: input.now,
    checkEveryMs: input.checkEveryMs,
    posts: 0,
    deadEnds: 0,
    claims: [],
    mentions: [],
    intents: [],
    coordination: input.coordination,
    crewReason: input.crewReason,
    oracle: input.oracle,
    workspaceRoot: input.workspaceRoot,
    copyOnWrite: input.copyOnWrite,
    allowNetwork: input.allowNetwork,
    toolPolicy: input.toolPolicy,
    sameRole: input.sameRole,
    prior: input.prior,
    experiments: [],
    deliveries: [],
    facts: [],
    hypotheses: [],
    arbitrations: [],
    lessons: [],
    usage: { costUSD: 0, tokens: 0 },
    notes: [],
  }
  return state
}

export function memberOf(state: FieldState, label: string): FieldMember | undefined {
  return state.members.find((member) => member.label === label)
}

export function memberBySession(state: FieldState, sessionID: string): FieldMember | undefined {
  return state.members.find((member) => member.sessionID === sessionID)
}

export function noteTurn(state: FieldState, label: string, now: number): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.turns += 1
  member.status = "working"
  member.lastTurnAt = now
  return next
}

export function notePost(state: FieldState, label: string, kind: FieldPostKind, now: number, text?: string): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.lastPostAt = now
  next.posts += 1
  if (kind === "dead-end") next.deadEnds += 1
  if (typeof text === "string" && text.trim().length > 0) {
    member.notebook = appendNotebook(member.notebook, notebookLine(kind, text))
  }
  return next
}

/** A left agent is permanently silent. Nothing in the driver may wake it. */
export function hasLeft(member: FieldMember | undefined): boolean {
  return member?.status === "left"
}

export function leaveMember(
  state: FieldState,
  input: { label: string; by: "self" | "user"; reason: string; now: number },
): FieldState {
  const next = clone(state)
  const member = memberOf(next, input.label)
  if (!member || member.status === "left") return state
  member.status = "left"
  member.leftAt = input.now
  member.leftBy = input.by
  member.leftReason = input.reason.trim().slice(0, 240) || "left the field"
  member.nudges = 0
  member.wrapped = false
  for (const intent of next.intents ?? []) {
    if (intent.status === "active" && intent.owner === member.label) intent.status = "released"
  }
  for (const mention of next.mentions ?? []) {
    if (mention.status !== "open") continue
    if (mention.from === member.label || mention.to === member.label) mention.status = "expired"
  }
  for (const experiment of next.experiments ?? []) {
    if (experiment.status !== "running" || experiment.owner !== member.label) continue
    experiment.status = "invalid"
    experiment.result = `${member.label} left the field; the running experiment is invalid`
    experiment.endedAt = input.now
  }
  return next
}

export function transferExperiment(
  state: FieldState,
  input: { id: string; to: string; by: string; now: number },
): FieldState {
  const next = clone(state)
  const experiment = (next.experiments ?? []).find((entry) => entry.id === input.id)
  const member = memberOf(next, input.to)
  if (!experiment || !member || member.status === "left") return state
  if (experiment.owner === input.to) return state
  experiment.evidence = [
    ...(experiment.evidence ?? []),
    `${input.by} handed ${experiment.id} to ${input.to} at ${new Date(input.now).toISOString()}`,
  ]
  experiment.owner = input.to
  return next
}

export function heartbeatIntents(state: FieldState, owners: string[], now: number, ttlMs: number): FieldState {
  const next = clone(state)
  let changed = false
  for (const intent of next.intents ?? []) {
    if (intent.status !== "active" || !owners.includes(intent.owner)) continue
    intent.heartbeatAt = now
    intent.expiresAt = now + Math.max(60_000, ttlMs)
    changed = true
  }
  return changed ? next : state
}

export function noteProgress(state: FieldState, now: number): FieldState {
  return { ...state, lastProgressAt: now }
}

export function noteDelivery(state: FieldState, record: DeliveryRecord): FieldState {
  const next = clone(state)
  next.deliveries = [...(next.deliveries ?? []), record].slice(-500)
  return next
}

export function markDelivered(state: FieldState, to: string, ids: readonly string[], now: number): FieldState {
  const wanted = new Set(ids)
  let changed = false
  const next = clone(state)
  next.deliveries = (next.deliveries ?? []).map((entry) => {
    if (!wanted.has(entry.id) || entry.to !== to || entry.deliveredAt !== undefined) return entry
    changed = true
    return { ...entry, deliveredAt: now }
  })
  return changed ? next : state
}

export function noteClaim(
  state: FieldState,
  input: { label: string; text: string; evidence: string[]; coverage?: string[]; now: number },
): FieldState {
  const next = clone(state)
  if (!memberOf(next, input.label)) return state
  next.claims.push({
    label: input.label,
    text: input.text,
    evidence: [...input.evidence],
    coverage: [...(input.coverage ?? [])],
    attempts: 0,
    at: input.now,
  })
  return next
}

export function rejectClaim(state: FieldState, label: string): FieldState {
  const next = clone(state)
  const claim = [...next.claims].reverse().find((entry) => entry.label === label)
  if (!claim) return state
  claim.attempts += 1
  return next
}

function pruneMentions(list: MentionRequest[], now: number): MentionRequest[] {
  const cutoff = now - MENTION_HISTORY_MS
  return list.filter((mention) => mention.status === "open" || mention.at >= cutoff).slice(-MENTION_LIMIT)
}

export function noteMention(
  state: FieldState,
  input: {
    id: string
    from: string
    to: string
    text: string
    at: number
    replyBy: number
    requiresReply: boolean
    senderWaits: boolean
  },
): FieldState {
  const next = clone(state)
  const current = next.mentions ?? []
  if (current.some((mention) => mention.id === input.id && mention.to === input.to && mention.status === "open")) {
    return state
  }
  next.mentions = pruneMentions(
    [
      ...current,
      {
        id: input.id,
        from: input.from,
        to: input.to,
        text: input.text,
        at: input.at,
        replyBy: input.replyBy,
        status: "open",
        requiresReply: input.requiresReply,
        senderWaits: input.senderWaits,
        delivery: "pending",
      },
    ],
    input.at,
  )
  return next
}

export function answerMention(state: FieldState, id: string, answeredBy: string): FieldState {
  const next = clone(state)
  const mention = (next.mentions ?? []).find((entry) => entry.id === id && entry.status === "open")
  if (!mention) return state
  mention.status = "answered"
  mention.answeredBy = answeredBy
  return next
}

/** Start the reply clock when the target actually receives the ask. */
export function markMentionDelivered(
  state: FieldState,
  id: string,
  to: string,
  now: number,
  windowMs: number,
): FieldState {
  const next = clone(state)
  const mention = (next.mentions ?? []).find(
    (entry) => entry.id === id && entry.to === to && entry.status === "open",
  )
  if (!mention) return state
  if (mention.delivery === "delivered") return state
  mention.delivery = "delivered"
  mention.deliveredAt = now
  if (mention.replyBy <= now) mention.replyBy = now + windowMs
  return next
}

export function expireMentions(state: FieldState, now: number): FieldState {
  const next = clone(state)
  let changed = false
  for (const mention of next.mentions ?? []) {
    const unseenTooLong = mention.delivery === "pending" && mention.at <= now - 10 * 60_000
    const replyExpired = mention.delivery !== "pending" && mention.replyBy <= now
    if (mention.status === "open" && (unseenTooLong || replyExpired)) {
      mention.status = "expired"
      changed = true
    }
  }
  if (!changed) return state
  next.mentions = pruneMentions(next.mentions ?? [], now)
  return next
}

export function openMentionsFor(state: FieldState, label: string, now: number): MentionRequest[] {
  return (state.mentions ?? []).filter(
    (mention) => mention.status === "open" && mention.to === label && mention.replyBy > now,
  )
}

export function openMentionFrom(state: FieldState, label: string, now: number): MentionRequest | undefined {
  return (state.mentions ?? []).find(
    (mention) => mention.status === "open" && mention.from === label && mention.senderWaits && mention.replyBy > now,
  )
}

export function noteIntent(
  state: FieldState,
  input: { id: string; owner: string; area: string; note: string; at: number; expiresAt: number },
): FieldState {
  const next = clone(state)
  const current = next.intents ?? []
  const existing = current.find(
    (intent) => intent.status === "active" && intent.owner === input.owner && intent.area === input.area,
  )
  if (existing) {
    existing.id = input.id
    existing.note = input.note
    existing.at = input.at
    existing.expiresAt = input.expiresAt
  } else {
    current.push({
      id: input.id,
      owner: input.owner,
      area: input.area,
      note: input.note,
      at: input.at,
      expiresAt: input.expiresAt,
      status: "active",
    })
  }
  next.intents = current.slice(-INTENT_LIMIT)
  return next
}

export function releaseIntent(
  state: FieldState,
  input: { owner: string; area?: string; now: number; status?: "released" | "expired" },
): FieldState {
  const next = clone(state)
  let changed = false
  for (const intent of next.intents ?? []) {
    if (intent.status !== "active" || intent.owner !== input.owner) continue
    if (input.area && intent.area !== input.area) continue
    intent.status = input.status ?? "released"
    changed = true
  }
  return changed ? next : state
}

export function expireIntents(state: FieldState, now: number): FieldState {
  const next = clone(state)
  let changed = false
  for (const intent of next.intents ?? []) {
    if (intent.status === "active" && intent.expiresAt <= now) {
      intent.status = "expired"
      changed = true
    }
  }
  return changed ? next : state
}

export function activeIntents(state: FieldState, now: number): FieldIntent[] {
  return (state.intents ?? []).filter((intent) => intent.status === "active" && intent.expiresAt > now)
}

export function noteLesson(state: FieldState, input: { label: string; text: string; at: number }): FieldState {
  const next = clone(state)
  const text = input.text.replace(/\s+/g, " ").trim()
  if (text.length === 0) return state
  const current = next.lessons ?? []
  if (current.some((lesson) => lesson.label === input.label && lesson.text === text)) return state
  next.lessons = [...current, { label: input.label, text, at: input.at }].slice(-LESSON_LIMIT)
  return next
}

export function setMember(state: FieldState, label: string, status: FieldMemberStatus): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.status = status
  if (status !== "working") {
    member.nudges = 0
  }
  return next
}

export function setSession(state: FieldState, label: string, sessionID: string): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.sessionID = sessionID
  member.status = "idle"
  return next
}

/**
 * A left agent can never be woken. There is intentionally no coordinator
 * override: only the User can end a field, and only the agent itself can
 * choose to leave it.
 */
export function wakeMember(state: FieldState, _label: string, _extraTurns = 0): FieldState {
  return state
}

export function noteReferee(
  state: FieldState,
  decision: "continue" | "pulse" | "report" | "abort",
  now: number,
): FieldState {
  const next = clone(state)
  next.lastRefereeDecision = decision
  next.lastRefereeAt = now
  return next
}

export function addUsage(state: FieldState, label: string, usage: Usage): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.costUSD += usage.costUSD
  member.tokens += usage.tokens
  next.usage = { costUSD: next.usage.costUSD + usage.costUSD, tokens: next.usage.tokens + usage.tokens }
  return next
}

export function noteNudge(state: FieldState, label: string): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.nudges += 1
  return next
}

export function noteCheck(state: FieldState, now: number): FieldState {
  const next = clone(state)
  next.lastCheckAt = now
  next.foremanTurns += 1
  return next
}

export function canTakeTurn(state: FieldState, label: string): boolean {
  const member = memberOf(state, label)
  if (!member) return false
  return member.status === "idle"
}

export function markWrapped(state: FieldState, label: string): FieldState {
  const next = clone(state)
  const member = memberOf(next, label)
  if (!member) return state
  member.wrapped = true
  return next
}

export function deadlineReached(state: FieldState, now: number): boolean {
  return state.status === "running" && state.deadlineAt > 0 && now >= state.deadlineAt
}

/** True when everybody still in the room chose to leave. */
export function allLeft(state: FieldState): boolean {
  return state.members.length > 0 && state.members.every((member) => member.status === "left")
}

export function memberQuietFor(state: FieldState, label: string, now: number): number {
  const member = memberOf(state, label)
  if (!member) return 0
  const last = Math.max(state.startedAt, member.lastTurnAt ?? 0, member.lastPostAt ?? 0)
  return Math.max(0, now - last)
}

export function finishField(state: FieldState, reason: FieldStopReason, note: string, now: number): FieldState {
  if (state.closed?.decision === "accepted" && state.status === "done") return state
  const next = clone(state)
  next.status = "done"
  next.stopReason = reason
  if (note.length > 0) next.notes.push(note)
  return next
}

export function acceptField(
  state: FieldState,
  input: { label: string; reason: string; evidence: string; now: number },
): FieldState {
  if (state.closed?.decision === "accepted") return state
  const next = clone(state)
  next.status = "done"
  next.stopReason = "accepted"
  next.closed = { decision: "accepted", reason: input.reason, evidence: input.evidence, at: input.now }
  for (const member of next.members) {
    if (member.status === "left") continue
    if (member.status !== "stopped" && member.status !== "failed") member.status = "done"
  }
  return next
}
