/**
 * The field driver — continuous peers on one bus.
 *
 * All host access arrives through `FieldDeps`, so the loop is testable without
 * an OpenCode session. The service owns sessions, rooms and storage; this class
 * owns the continuous inbox, the referee and the claim gate.
 */

import {
  activeIntents,
  addUsage,
  answerMention,
  canTakeTurn,
  deadlineReached,
  expireIntents,
  expireMentions,
  finishField,
  heartbeatIntents,
  hasLeft,
  leaveMember,
  markDelivered as markDeliveredRecords,
  markMentionDelivered,
  memberBySession,
  memberOf,
  memberQuietFor,
  noteCheck,
  noteClaim,
  noteIntent,
  noteLesson,
  noteMention,
  notePost,
  noteProgress,
  noteReferee,
  noteTurn,
  openField,
  openMentionFrom,
  releaseIntent,
  rejectClaim,
  setMember,
  setSession,
  transferExperiment,
  allLeft,
  acceptField,
  type DeliveryRecord,
  type FieldMember,
  type FieldPostKind,
  type FieldState,
  type MentionRequest,
} from "../core/field.ts"
import { enqueue, INBOX_CAP, pending, shouldFlush, take, type InboxItem, type InboxState } from "../core/inbox.ts"
import { judgeClaim } from "../core/gate.ts"
import { grantLease, releaseLease } from "../core/lease.ts"
import { openArbitration, proposeFact, resolveArbitration as resolveFactArbitration } from "../core/blackboard.ts"
import { buildReport } from "../core/report.ts"
import { deltaCard, stateCard } from "../core/card.ts"
import { experimentLine, finishExperiment, runningExperiment, startExperiment } from "../core/experiment.ts"
import { priorLine } from "../core/prior.ts"
import { extractJSON } from "../json.ts"
import { isSealed, sealSession } from "../seal.ts"
import type { FieldBoard, Fact, Oracle, RoomKind, RoomMessage, RoomRole, Usage } from "../types.ts"
import type { PromptFile, WaitOutcome } from "../runtime.ts"
import {
  boardText,
  claimRejectedPrompt,
  crewFromState,
  falsifyPrompt,
  inboxBodyLimit,
  inboxPrompt,
  kickoffPrompt,
  mentionExpiredPrompt,
  parseReferee,
  pulsePrompt,
  refereePrompt,
  socialBlock,
} from "./prompts.ts"
import { FOREMAN_NAME } from "./roster.ts"

export interface FieldPostInput {
  author: string
  kind: FieldPostKind
  text: string
  detail?: string
  to?: string[] | "all"
  evidence?: string[]
  /** For claim: what was proven and what was not. */
  coverage?: string[]
  replyTo?: string
  replyInSeconds?: number
  area?: string
  leaseMinutes?: number
  leaseKind?: string
  paths?: string[]
  basedOn?: string[]
  contradicts?: string[]
  /** For test: the one command and the expected observation. */
  command?: string
  expect?: string
  killIf?: string
  preflight?: string
  baseline?: string
  /** For result: the experiment id and its raw observation. */
  experiment?: string
  result?: "pass" | "fail" | "invalid"
  observed?: string
  pidBefore?: string
  pidAfter?: string
  /** For oracle: what kind of observation the baseline captures. */
  oracleKind?: Oracle["kind"]
  /** For oracle: when the observation was taken, if the evidence is older. */
  baselineAt?: number
  /** For oracle: the process/file path the observation belongs to. */
  scope?: string
  /** For oracle: the PID, session or writer that produced the observation. */
  writer?: string
}

export interface FieldPost {
  author: string
  authorRole: "user" | "agent" | "orchestrator" | "system"
  kind: RoomKind
  text: string
  detail?: string
  to?: string[] | "all"
  mentions?: string[]
  private?: boolean
  order?: boolean
  replyTo?: string
  runID: string
}

export interface FieldDeps {
  now(): number
  /** The main session that receives coordinator updates. */
  parentSessionID: string
  prompt(
    sessionID: string,
    text: string,
    options?: { delivery?: "steer" | "queue"; resume?: boolean; files?: PromptFile[] },
  ): Promise<void>
  wait(sessionID: string, timeoutMs: number): Promise<WaitOutcome>
  info(sessionID: string): Promise<{ outcome?: string; updatedAt?: number } | undefined>
  /** The oldest running job for a seat. A foreground job owns the run lock. */
  jobFor?(label: string): { id: string; startedAt: number; foreground?: boolean } | undefined
  stopJob?(id: string): Promise<void> | void
  /** How long a foreground job may run before the field treats it as stuck. */
  stallAfterMs?: number
  finalText(sessionID: string): Promise<string>
  usage(sessionID: string): Promise<Usage>
  interrupt(sessionID: string): Promise<void>
  verify(command: string, label: string, timeoutMs: number): Promise<{ ok: boolean; output: string }>
  post(input: FieldPost): Promise<{ id: string }>
  save(state: FieldState): Promise<void>
  /** Persist the final report as prior memory for the same objective. */
  remember?(state: FieldState): Promise<void> | void
  /** Remove copy-on-write worktrees when the field ends. */
  cleanup?(members: FieldMember[]): Promise<void> | void
  /** Stop one or more agents' tracked jobs without removing their workspace. */
  stopJobs?(labels: string[]): void
  flushDelayMs: number
  /** How often peer activity is batched for the coordinator. */
  coordinatorDigestMs: number
  maxCoordinatorOrders?: number
  coordinatorMinIntervalMs?: number
  coordinatorMaxChars?: number
  maxExperiments?: number
  decideMinutes?: number
  /** Advisory only: a quiet field gets a prompt to report or leave; no forced stop. */
  maxNoProgressMinutes?: number
  quietMs: number
  turnTimeoutMs: number
  verifyTimeoutMs: number
  foremanTimeoutMs: number
  mentionTimeoutMs: number
  intentLeaseMs: number
  cancelled(): boolean
}

function roomKindOf(kind: FieldPostKind): RoomKind {
  if (kind === "note") return "chat"
  if (kind === "status") return "system"
  return kind
}

function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

const ACK_LIKE =
  /^(?:accepted|ack|acknowledged|confirmed|agreed|correct|noted|yes|no|will do|understood|holding|standing down|on it|copy that)\b/i

/** A short acknowledgment adds no fact. It is stored, not delivered. */
function isAck(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= 180 && ACK_LIKE.test(clean)
}

function claimKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function claimWords(text: string): Set<string> {
  return new Set(claimKey(text).split(" ").filter((word) => word.length > 2))
}

/** Cheap Jaccard similarity, enough to catch two agents proving the same line. */
function claimSimilarity(left: string, right: string): number {
  const a = claimWords(left)
  const b = claimWords(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

function duplicateFact(state: FieldState, claim: string): Fact | undefined {
  const key = claimKey(claim)
  if (key.length < 24) return undefined
  return (state.facts ?? []).find(
    (fact) =>
      fact.status !== "superseded" &&
      fact.status !== "refuted" &&
      (claimKey(fact.claim) === key || claimSimilarity(fact.claim, claim) >= 0.82),
  )
}

interface CoordinatorItem {
  id: string
  author: string
  role: "user" | "agent" | "orchestrator" | "system"
  kind: RoomKind
  text: string
  at: number
  order: boolean
  mentions: string[]
  files?: PromptFile[]
}

export class FieldRun {
  private state: FieldState
  private inbox: InboxState = {}
  private readonly dropped = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly steering = new Set<string>()
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastPost = new Map<string, string>()
  private coordinatorQueue: CoordinatorItem[] = []
  private coordinatorDropped = 0
  private lastCoordinatorAt = 0
  private lastPrincipalAt = 0
  private lastVeraPostAt = 0
  private coordinatorChain: Promise<void> = Promise.resolve()
  private stopped = false
  private started = false
  private adoptedAt = 0
  private ticking = false
  private postsAtCheck = 0
  private lastPulseAt = 0
  private gateChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: FieldDeps,
    state: FieldState,
  ) {
    this.state = state
    this.lastCoordinatorAt = deps.now()
  }

  get snapshot(): FieldState {
    return this.state
  }

  private now(): number {
    return this.deps.now()
  }

  private memberBySession(sessionID: string): FieldMember | undefined {
    return memberBySession(this.state, sessionID)
  }

  private async save(): Promise<void> {
    await this.deps.save(this.state)
  }

  private lastActivity(member: FieldMember): number {
    return Math.max(this.state.startedAt, member.lastTurnAt ?? 0, member.lastPostAt ?? 0)
  }

  private mentionsFor(member: FieldMember, mentions?: string[]): boolean {
    const label = member.label.toLowerCase()
    return (mentions ?? []).some((name) => name.toLowerCase() === label)
  }

  private mentionFor(messageID: string, label: string): MentionRequest | undefined {
    return (this.state.mentions ?? []).find(
      (mention) => mention.id === messageID && mention.to === label && mention.status === "open",
    )
  }

  private replyWindow(seconds?: number): number {
    const value = typeof seconds === "number" ? seconds * 1_000 : this.deps.mentionTimeoutMs
    return clampNumber(value, this.deps.mentionTimeoutMs, 10_000, 600_000)
  }

  private pendingHasMention(label: string): boolean {
    return (this.inbox[label] ?? []).some((item) => item.mention === true)
  }

  private markDelivered(label: string, items: readonly InboxItem[]): void {
    const now = this.now()
    this.state = markDeliveredRecords(
      this.state,
      label,
      items.map((item) => item.id),
      now,
    )
    for (const item of items) {
      if (!item.mention || !item.fromMessageID) continue
      this.state = markMentionDelivered(this.state, item.fromMessageID, label, now, this.deps.mentionTimeoutMs)
    }
  }

  private queueCoordinator(input: CoordinatorItem): void {
    if (this.stopped || input.role === "orchestrator") return
    // Commentary does not wake the coordinator. It reads facts, blockers and
    // decisions; status pings, lessons and acks are noise.
    if (["status", "note", "lesson", "probe", "answer"].includes(input.kind)) return
    // A same-role room is deliberately quiet: only a solution, a blocker or a
    // direct ask to the coordinator should pull it back in. Facts, tests,
    // results, oracles and Vera's routine verdicts belong on the card and in
    // the room; waking the coordinator for each one turns it into a commentator
    // and multiplies the token bill.
    if (this.state.sameRole) {
      const direct = input.mentions.some((target) => /^(?:orchestrator|user)$/i.test(target))
      // The coordinator needs the facts, not only blockers. The queue is
      // coalesced (90s or 12 items), so this is a digest rather than one wake
      // per post.
      const allowed =
        input.kind === "claim" ||
        input.kind === "dead-end" ||
        input.kind === "fact" ||
        input.kind === "finding" ||
        input.kind === "result" ||
        input.kind === "oracle" ||
        (direct && (input.kind === "request" || input.kind === "question"))
      if (!allowed) return
    }
    const text = clamp(input.text, 360)
    if (text.length === 0) return
    this.coordinatorQueue.push({ ...input, text })
    if (this.coordinatorQueue.length > 30) {
      this.coordinatorQueue.shift()
      this.coordinatorDropped += 1
    }
  }

  private mayWake(member: FieldMember, _role: CoordinatorItem["role"], _order: boolean, _mentioned: boolean): boolean {
    // Only an agent that chose to leave is gone for good. Even the coordinator
    // cannot wake it. Everyone else is still a peer in the room.
    return member.status !== "left" && !isSealed(member.sessionID)
  }

  private coordinatorEnvelope(items: CoordinatorItem[], priority: boolean, urgent: boolean): string {
    const now = this.now()
    const board = this.board()
    const crew = board.members
      .map((member) => `${member.label} ${member.status}${member.waitingFor ? ` waiting on ${member.waitingFor}` : ""}`)
      .join(", ")
    const omitted = this.coordinatorDropped > 0 ? `${this.coordinatorDropped} older update(s) omitted\n` : ""
    this.coordinatorDropped = 0
    const lines = items.map((item) => {
      const to = item.mentions.length > 0 ? ` @${item.mentions.join(" @")}` : ""
      const flag = item.order ? " ORDER" : ""
      const files = item.files?.length ? ` (${item.files.length} file(s) attached)` : ""
      return `#${item.id} [${item.kind}${flag}] ${item.author}${to}: ${item.text}${files}`
    })
    const headline = priority
      ? "The User or a direct order needs your attention now."
      : urgent
        ? "The field needs a coordinator decision now."
        : "Room update while you supervise."
    return `[arena.coordinator] ${headline}
${stateCard(this.state, "Coordinator", now, this.healthLine(now))}

${omitted}${lines.join("\n")}

Field ${board.runID}: ${board.status}, ${board.posts} posts, ${board.deadEnds} dead ends, ${board.claims} claim(s)${board.openMentions ? `, ${board.openMentions} open ask(s)` : ""}.
${board.delivery ? `Delivery: ${board.delivery.delivered}/${board.delivery.queued} delivered, p50 ${board.delivery.p50Ms ?? "?"}ms, p90 ${board.delivery.p90Ms ?? "?"}ms, ${board.delivery.truncated} truncated.` : ""}
Referee: ${board.referee ? `${board.referee.name} ${board.referee.status}, ${board.referee.checks} check(s)` : "none"}.

You are the coordinator, not a worker. Do not run shell, read, edit, browser or subagent tools while the field is live. Use arena status/read to inspect the room, and arena chat or steer to guide the crew. Answer the User. If the message asks for work, name an owner in the room instead of doing it yourself. Do not post just to acknowledge. Do not poll in a loop: this channel wakes you again when the room changes. Only the User can stop the field or force an agent to leave; you cannot. Budget: ${this.deps.maxCoordinatorOrders ?? 16} orders, one decision per ${Math.round((this.deps.coordinatorMinIntervalMs ?? 30_000) / 1_000)}s, ${this.deps.coordinatorMaxChars ?? 600} characters, one owner. A plain chat does not spend the order budget; keep it short. If no decision is needed, end your turn. (${Math.round((now - this.state.startedAt) / 60_000)}m elapsed.)`
  }

  private pumpCoordinator(force = false, final = false): Promise<void> {
    const next = this.coordinatorChain.then(() => this.pumpCoordinatorNow(force, final))
    this.coordinatorChain = next.catch(() => undefined)
    return next
  }

  private async pumpCoordinatorNow(force = false, final = false): Promise<void> {
    if ((this.stopped && !final) || this.coordinatorQueue.length === 0) return
    const now = this.now()
    const priority = this.coordinatorQueue.some((item) => item.role === "user" || item.order)
    const age = now - this.lastCoordinatorAt
    if (!force && !priority && age < this.deps.coordinatorDigestMs && this.coordinatorQueue.length < 12) return
    const batch = this.coordinatorQueue
    this.coordinatorQueue = []
    this.lastCoordinatorAt = now
    const files = batch.flatMap((item) => item.files ?? []).slice(0, 4)
    try {
      await this.deps.prompt(this.deps.parentSessionID, this.coordinatorEnvelope(batch, priority, force), {
        delivery: "steer",
        resume: true,
        files: files.length > 0 ? files : undefined,
      })
    } catch {
      // A failed wake must not lose the messages queued behind it.
      this.coordinatorQueue = [...batch, ...this.coordinatorQueue]
    }
  }

  private async finalNotice(item: Omit<CoordinatorItem, "files">): Promise<void> {
    this.coordinatorQueue.push({ ...item })
    await this.pumpCoordinator(true, true)
  }

  /**
   * Coalesce room traffic before it reaches a model turn. One prompt per batch,
   * not one prompt per post. P0 is immediate, P1 waits 2s, P2 waits 5s.
   */
  private scheduleDelivery(label: string, priority: 0 | 1 | 2 | 3): void {
    if (this.stopped || priority >= 3) return
    const current = this.deliveryTimers.get(label)
    if (current) clearTimeout(current)
    const delay = priority === 0 ? 0 : priority === 1 ? this.deps.flushDelayMs : this.deps.flushDelayMs * 2
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(label)
      if (this.stopped || pending(this.inbox, label) === 0) return
      const member = memberOf(this.state, label)
      if (!member || isSealed(member.sessionID)) return
      if (member.status === "working") void this.steer(label).catch(() => undefined)
      else if (member.status === "idle" && !this.busy.has(label)) void this.flush(label).catch(() => undefined)
    }, delay)
    timer.unref?.()
    this.deliveryTimers.set(label, timer)
  }

  /** Inject a peer batch at the next safe point, even while the agent is in a long turn. */
  private async steer(label: string): Promise<void> {
    if (this.stopped || this.steering.has(label)) return
    const member = memberOf(this.state, label)
    if (!member || member.status !== "working" || isSealed(member.sessionID) || pending(this.inbox, label) === 0) return
    this.steering.add(label)
    try {
      while (!this.stopped && pending(this.inbox, label) > 0) {
        const current = memberOf(this.state, label)
        if (!current || current.status !== "working") break
        const taken = take(this.inbox, label)
        this.inbox = taken.state
        const omitted = this.dropped.get(label) ?? 0
        this.dropped.set(label, 0)
        const text = inboxPrompt({
          objective: this.state.contract.objective,
          items: taken.items,
          omitted,
          now: this.now(),
        })
        const card = this.cardFor(current, text)
        try {
          await this.deps.prompt(current.sessionID, card, { delivery: "steer", resume: true })
        } catch {
          for (const item of taken.items) this.enqueueFor(current, item)
          break
        }
        this.markDelivered(label, taken.items)
        this.markCardSeen(label)
        await this.save()
      }
    } finally {
      this.steering.delete(label)
      const after = memberOf(this.state, label)
      if (after?.status === "idle" && pending(this.inbox, label) > 0) void this.flush(label).catch(() => undefined)
    }
  }

  private enqueueFor(member: FieldMember, item: InboxItem): void {
    if (pending(this.inbox, member.label) >= INBOX_CAP) {
      this.dropped.set(member.label, (this.dropped.get(member.label) ?? 0) + 1)
    }
    this.recordDelivery({
      id: item.id,
      to: member.label,
      author: item.author,
      kind: item.kind,
      sentAt: item.at,
      chars: item.text.length,
      truncated: item.text.length > inboxBodyLimit(item.kind),
    })
    this.inbox = enqueue(this.inbox, member.label, item)
  }

  /** Keep the ledger update shallow: one fanout can touch 50 seats. */
  private recordDelivery(record: DeliveryRecord): void {
    this.state = {
      ...this.state,
      deliveries: [...(this.state.deliveries ?? []), record].slice(-500),
    }
  }

  private clearInbox(label: string): void {
    this.inbox = take(this.inbox, label).state
    this.dropped.set(label, 0)
  }

  private async beginTurn(member: FieldMember, text: string, force = false): Promise<void> {
    if (this.stopped || this.deps.cancelled() || isSealed(member.sessionID)) return
    if (this.busy.has(member.label)) return
    if (!force && !canTakeTurn(this.state, member.label)) return
    this.busy.add(member.label)
    try {
      this.state = noteTurn(this.state, member.label, this.now())
      await this.save()
      let delivered = false
      try {
        await this.deps.prompt(member.sessionID, text)
        delivered = true
      } catch {
        // A prompt that cannot be delivered must not enter an unbounded wait.
        // The member returns to idle and the next room message can retry.
      }
      if (delivered) {
        let outcome: WaitOutcome = "error"
        try {
          // 0 is a continuous turn: wait until the agent itself stops. A positive
          // value is an operator safety valve, never a normal 10-minute cut.
          outcome = await this.deps.wait(member.sessionID, this.deps.turnTimeoutMs)
        } catch {
          outcome = "error"
        }
        if (outcome === "timeout" && this.deps.turnTimeoutMs > 0) {
          await this.deps.interrupt(member.sessionID).catch(() => undefined)
        }
      }
      await this.settle(member.label)
    } finally {
      this.busy.delete(member.label)
    }
    if (pending(this.inbox, member.label) > 0) void this.flush(member.label)
  }

  private async settle(label: string): Promise<void> {
    if (this.stopped) return
    const member = memberOf(this.state, label)
    if (!member || member.status !== "working") return
    if (hasLeft(member)) return
    let usage: Usage = { costUSD: 0, tokens: 0 }
    try {
      usage = await this.deps.usage(member.sessionID)
    } catch {
      usage = { costUSD: 0, tokens: 0 }
    }
    this.state = addUsage(this.state, label, usage)
    this.state = setMember(this.state, label, "idle")
    await this.save()
  }

  private async flush(label: string): Promise<void> {
    const member = memberOf(this.state, label)
    if (!member || member.status !== "idle" || this.busy.has(label) || this.stopped) return
    if (isSealed(member.sessionID)) {
      this.clearInbox(label)
      return
    }
    if (!canTakeTurn(this.state, label)) return
    if (pending(this.inbox, label) === 0) return
    const taken = take(this.inbox, label)
    this.inbox = taken.state
    this.markDelivered(label, taken.items)
    const omitted = this.dropped.get(label) ?? 0
    this.dropped.set(label, 0)
    const text = this.cardFor(
      member,
      inboxPrompt({
        objective: this.state.contract.objective,
        items: taken.items,
        omitted,
        now: this.now(),
      }),
    )
    await this.beginTurn(member, text)
    this.markCardSeen(label)
    await this.save()
  }

  private async fanout(input: {
    id: string
    author: string
    authorRole?: RoomRole
    kind: FieldPostKind
    text: string
    to: string[] | "all"
    mentions?: string[]
    files?: PromptFile[]
    order?: boolean
    principal?: boolean
    area?: string
    replyTo?: string
    experiment?: string
    at: number
  }): Promise<void> {
    const role = input.authorRole ?? "agent"
    if (role === "agent" && isAck(input.text)) return
    this.queueCoordinator({
      id: input.id,
      author: input.author,
      role,
      kind: roomKindOf(input.kind),
      text: input.text,
      at: input.at,
      order: input.order === true,
      mentions: input.mentions ?? [],
      files: input.files,
    })
    const selective = input.kind === "fact" || input.kind === "result"
    const area = (input.area ?? "").toLowerCase()
    for (const original of this.state.members) {
      if (original.label === input.author) continue
      const mentioned = this.mentionsFor(original, input.mentions) || (input.mentions ?? []).includes("all")
      // Same-role rooms are intentionally quiet: only a solution, a blocker, a
      // shared fact/result or a direct ask should reach every seat.
      const sameRoleBroadcast = [
        "fact",
        "finding",
        "result",
        "oracle",
        "dead-end",
        "claim",
        "request",
        "question",
        "answer",
        "intent",
      ].includes(input.kind)
      if (this.state.sameRole && !sameRoleBroadcast && !mentioned) continue
      // A fact updates the card; it does not need a prompt to all 50 seats. The
      // owner of the matching lane and the verifier get it now, everyone else
      // sees it on the next card.
      if (selective && !mentioned && !this.state.sameRole) {
        const lane = original.workstream
        const verifier = lane?.kind === "verify" || lane?.kind === "integrate"
        const owns = (lane?.owns ?? []).some(
          (own) => own.length > 0 && (area.includes(own.toLowerCase()) || own.toLowerCase().includes(area)),
        )
        if (!verifier && !owns) continue
      }
      const mention = this.mentionFor(input.id, original.label)
      if (!this.mayWake(original, role, input.order === true, mentioned)) continue
      if (isSealed(original.sessionID)) continue
      const member = original
      if (input.order || input.principal) {
        const prefix = mentioned ? `MENTION for ${member.label}. ` : ""
        if (member.status !== "working") {
          this.state = noteTurn(this.state, member.label, this.now())
          await this.save()
        }
        const attached = input.files?.length ? ` (${input.files.length} file(s) attached)` : ""
        const due = mention ? ` They are waiting until ${mention.replyBy} for your answer; reply with arena_bus post kind=answer and replyTo=${input.id}.` : ""
        const envelope = `[arena.room ${input.id} from ${input.author}] ${prefix}${input.text}${attached}${due}
This is from the User or the Orchestrator. Follow it at the next safe point; if it is impossible, say why in the room.`
        try {
          await this.deps.prompt(member.sessionID, envelope, {
            delivery: "steer",
            resume: true,
            files: input.files,
          })
          if (mention) {
            this.state = markMentionDelivered(this.state, input.id, member.label, this.now(), this.deps.mentionTimeoutMs)
            await this.save()
          }
        } catch {
          // The room keeps the message even if a live steer fails.
        }
        continue
      }
      this.enqueueFor(member, {
        id: input.id,
        author: input.author,
        kind: roomKindOf(input.kind),
        text: input.text,
        to: "all",
        at: input.at,
        mention: mentioned,
        mentionAll: (input.mentions ?? []).includes("all"),
        replyBy: mention?.replyBy,
        fromMessageID: mention?.id,
        area: input.area,
        replyTo: input.replyTo,
        experiment: input.experiment,
      })
      // An idle peer named in an ask should wake now, not after a debounce.
      if (mention && member.status === "idle" && !this.busy.has(member.label)) {
        void this.flush(member.label).catch(() => undefined)
      } else {
        const priority: 0 | 1 | 2 | 3 = mentioned || mention ? 1 : 2
        this.scheduleDelivery(member.label, priority)
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const now = this.now()
    const minutes =
      this.state.deadlineAt > 0
        ? Math.max(1, Math.round((this.state.deadlineAt - this.state.startedAt) / 60_000))
        : 0
    const peers = this.state.members.filter((member) => member.status !== "left").map((member) => member.label)
    const crew = crewFromState(this.state)
    await Promise.all(
      this.state.members
        .filter((member) => member.status !== "left")
        .map((member) => {
          const base = kickoffPrompt({
            contract: this.state.contract,
            member: { label: member.label, role: member.stance.name, brief: member.stance.objective },
            peers,
            deadlineMinutes: minutes,
            crew,
            foreman: FOREMAN_NAME,
            now,
            mentionTimeoutSeconds: Math.round(this.deps.mentionTimeoutMs / 1_000),
            leaseMinutes: Math.round(this.deps.intentLeaseMs / 60_000),
            social: socialBlock({ state: this.state, label: member.label, now }),
            coordination: this.state.coordination,
            workstream: member.workstream,
            workspaceRoot: this.state.workspaceRoot,
            workspacePath: member.workspacePath,
            copyOnWrite: this.state.copyOnWrite,
            toolPolicy: this.state.toolPolicy,
            sameRole: this.state.sameRole,
          })
          const prior = priorLine(this.state)
          const text = `${stateCard(this.state, member.label, now, this.healthLine(now))}\n\n${prior ? `${prior}\n\n` : ""}${base}`
          return this.beginTurn(member, text)
        }),
    )
    this.state = {
      ...this.state,
      members: this.state.members.map((member) => ({ ...member, cardSeen: true })),
    }
    await this.save()
  }

  /**
   * Continue a live field with a new mission on the same agents, sessions,
   * workspace and history. No new seats, no new run id.
   */
  async continueWith(input: { mission: string; maxDurationMinutes?: number }): Promise<{ ok: boolean; text: string }> {
    if (this.stopped) return { ok: false, text: "the field is closed" }
    const mission = input.mission.replace(/\s+/g, " ").trim()
    if (mission.length < 8) return { ok: false, text: "continue needs a mission sentence" }
    const active = this.state.members.filter((member) => !hasLeft(member) && !isSealed(member.sessionID))
    if (active.length === 0) return { ok: false, text: "every agent has left; start a new field instead" }
    const now = this.now()
    const previous = this.state.contract.objective
    this.state = {
      ...this.state,
      status: "running",
      stopReason: undefined,
      closed: undefined,
      contract: {
        ...this.state.contract,
        objective: mission,
        context: `${this.state.contract.context ?? ""}\nContinuing from: ${previous}\nNew mission: ${mission}`.trim(),
      },
      deadlineAt:
        input.maxDurationMinutes && input.maxDurationMinutes > 0
          ? now + input.maxDurationMinutes * 60_000
          : 0,
      lastProgressAt: now,
      lastCheckAt: now,
      orders: 0,
      notes: [...this.state.notes, `continued mission: ${mission}`],
    }
    const notice = `Field ${this.state.id} continued on the same ${active.length} agent(s): ${mission}`
    const posted = await this.deps
      .post({
        author: "System",
        authorRole: "system",
        kind: "lifecycle",
        text: notice,
        to: "all",
        runID: this.state.id,
      })
      .catch(() => undefined)
    this.lastPrincipalAt = 0
    await this.save()
    const prompt = `[arena.continue] Same crew, same workspace, same history. New mission: ${mission}
The previous mission was: ${previous}
Read the card and the room, then continue. Do not restart work that is already on the board.`
    // Start every seat without blocking the command on the first long turn.
    // The room is already saved; the agents continue in parallel.
    for (const member of active) {
      if (member.status === "working") {
        void this.deps
          .prompt(member.sessionID, `${this.cardFor(member, prompt)}`, { delivery: "steer", resume: true })
          .catch(() => undefined)
      } else {
        void this.beginTurn(member, this.cardFor(member, prompt)).catch(() => undefined)
      }
    }
    if (posted) {
      this.queueCoordinator({
        id: posted.id,
        author: "System",
        role: "system",
        kind: "lifecycle",
        text: notice,
        at: now,
        order: false,
        mentions: [],
      })
      await this.pumpCoordinator(true)
    }
    return { ok: true, text: notice }
  }

  async resume(): Promise<void> {
    this.started = true
    // A process restart leaves persisted members marked "working" even though no
    // turn is running. Reset them so the field can actually resume.
    let reset = this.state
    for (const member of reset.members) {
      if (member.status === "working") reset = setMember(reset, member.label, "idle")
    }
    this.state = reset
    await this.save()
    if (allLeft(this.state)) {
      this.state = finishField(this.state, "all-left", "every agent left the field", this.now())
      await this.save()
      return
    }
    const pendingMembers = this.state.members.filter(
      (member) => member.status === "idle" && !isSealed(member.sessionID),
    )
    await Promise.all(
      pendingMembers.map(async (member) => {
        if (member.status !== "idle") return
        if (pending(this.inbox, member.label) > 0) return this.flush(member.label)
        this.state = setMember(this.state, member.label, "idle")
        const workspace = this.state.copyOnWrite
          ? ` Workspace: shared baseline ${this.state.workspaceRoot ?? "the field root"}; your writable copy ${member.workspacePath ?? "your own copy"}. Copy before modifying.`
          : ""
        return this.beginTurn(
          member,
          `Resume: you are still in the Arena. Continue from your own last state; read the room first and do not repeat work that is already done. Use arena_fs/arena_exec/arena_job when a task touches the tree; host tools are available under the full tool profile and no target is out of scope. Goal: ${this.state.contract.objective}${workspace}\n\n${stateCard(this.state, member.label, this.now(), this.healthLine(this.now()))}`,
        )
      }),
    )
    this.state = {
      ...this.state,
      members: this.state.members.map((member) => ({ ...member, cardSeen: true })),
    }
    await this.save()
  }

  /** Take over after a plugin hot reload without restarting live agent turns. */
  async adopt(): Promise<void> {
    this.started = true
    this.adoptedAt = this.now()
    await this.save()
  }

  async attach(label: string, sessionID: string): Promise<void> {
    const existing = memberOf(this.state, label)
    if (hasLeft(existing)) return
    this.state = setSession(this.state, label, sessionID)
    await this.save()
    const member = memberOf(this.state, label)
    if (!member) return
    const workspace = this.state.copyOnWrite
      ? `\nWorkspace: shared baseline ${this.state.workspaceRoot ?? "the field root"}; your writable copy ${member.workspacePath ?? "your own copy"}. Copy before modifying; do not edit the shared baseline.`
      : ""
    await this.beginTurn(
      member,
      `Resume: your previous session was lost and this is a fresh one. Your notebook:
${member.notebook || "empty"}
Continue the work from there; post what you learn. Use arena_fs/arena_exec/arena_job when a task touches the tree; host tools are available under the full tool profile and no target is out of scope. Goal: ${this.state.contract.objective}${workspace}\n\n${stateCard(this.state, member.label, this.now(), this.healthLine(this.now()))}`,
    )
    this.markCardSeen(label)
    await this.save()
  }

  /** Bind a launch lease to the job and PID that actually own it. */
  async attachLaunch(label: string, jobID: string, pid?: number): Promise<void> {
    let changed = false
    const intents = (this.state.intents ?? []).map((intent) => {
      if (intent.status !== "active" || intent.owner !== label || intent.kind !== "launch") return intent
      if (intent.jobID && intent.jobID !== jobID) return intent
      changed = true
      return { ...intent, jobID, pid: pid ?? intent.pid }
    })
    if (!changed) return
    this.state = { ...this.state, intents }
    await this.save()
  }

  /** Release only the launch lease that belongs to this finished job. */
  async releaseLaunch(label: string, jobID: string): Promise<void> {
    let changed = false
    const intents = (this.state.intents ?? []).map((intent) => {
      if (intent.status !== "active" || intent.owner !== label) return intent
      if (intent.jobID !== jobID) return intent
      changed = true
      return { ...intent, status: "released" as const }
    })
    if (!changed) return
    this.state = { ...this.state, intents }
    await this.save()
  }

  /**
   * The only two ways out: the agent's own decision, or the User's force.
   * A leave seals the session permanently; the coordinator has no override.
   */
  async leave(input: { label: string; by: "self" | "user"; reason: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.stopped) return { ok: false, error: "the field is closed" }
    const member = memberOf(this.state, input.label)
    if (!member) return { ok: false, error: `no agent named ${input.label}` }
    if (member.status === "left") return { ok: false, error: `${member.label} already left` }
    const reason = input.reason.trim() || (input.by === "user" ? "removed by the User" : "left by own decision")
    this.state = leaveMember(this.state, { label: member.label, by: input.by, reason, now: this.now() })
    const at = this.now()
    const posted = await this.deps
      .post({
        author: input.by === "user" ? "User" : member.label,
        authorRole: input.by === "user" ? "user" : "agent",
        kind: input.by === "user" ? "order" : "handoff",
        text:
          input.by === "user"
            ? `User removed ${member.label} from the field: ${reason}`
            : `${member.label} left the field: ${reason}`,
        to: "all",
        runID: this.state.id,
      })
      .catch(() => undefined)
    this.clearInbox(member.label)
    const leavingSession = member.sessionID
    sealSession(leavingSession, {
      label: member.label,
      runID: this.state.id,
      reason: "left",
      at,
    })
    // `leave` is called from inside the leaving session's own tool call. Awaiting
    // the interrupt here aborts that tool call and turns a successful leave into
    // "Tool execution interrupted". Seal immediately, then let the turn unwind
    // before interrupting it.
    setTimeout(() => {
      void this.deps.interrupt(leavingSession).catch(() => undefined)
    }, 50)
    this.deps.stopJobs?.([member.label])
    await this.save()
    if (posted) {
      await this.fanout({
        id: posted.id,
        author: input.by === "user" ? "User" : member.label,
        authorRole: input.by === "user" ? "user" : "agent",
        kind: "handoff",
        text: input.by === "user" ? `User removed ${member.label} from the field.` : `${member.label} left the field.`,
        to: "all",
        mentions: [],
        at,
        principal: input.by === "user",
      })
    }
    if (allLeft(this.state)) {
      this.state = finishField(this.state, "all-left", "every agent left the field", at)
      this.state = { ...this.state, report: buildReport(this.state) }
      if (this.state.foremanSessionID) {
        await this.deps.interrupt(this.state.foremanSessionID).catch(() => undefined)
      }
      await this.save()
      await Promise.resolve(this.deps.remember?.(this.state)).catch(() => undefined)
      await Promise.resolve(this.deps.cleanup?.(this.state.members)).catch(() => undefined)
      const text = `Field ${this.state.id} ended: every agent left. No agent can be woken back into this field.`
      await this.deps
        .post({
          author: "System",
          authorRole: "system",
          kind: "lifecycle",
          text,
          to: "all",
          runID: this.state.id,
        })
        .catch(() => undefined)
      await this.finalNotice({
        id: "all-left",
        author: "System",
        role: "system",
        kind: "lifecycle",
        text: `${text} Answer the User with the final result now.`,
        at,
        order: false,
        mentions: [],
      }).catch(() => undefined)
    }
    return { ok: true }
  }

  private resolveMentions(text: string, to?: string[] | "all"): string[] {
    const labels = new Map(this.state.members.map((member) => [member.label.toLowerCase(), member.label]))
    const found = new Set<string>()
    for (const match of text.matchAll(/@([A-Za-z][A-Za-z0-9_-]*)/g)) {
      const raw = (match[1] as string).toLowerCase()
      if (raw === "all") {
        found.add("all")
        continue
      }
      const label = labels.get(raw)
      if (label) found.add(label)
    }
    if (Array.isArray(to)) {
      for (const target of to) {
        const label = labels.get(target.toLowerCase())
        if (label) found.add(label)
      }
    }
    return [...found]
  }

  async notePost(input: FieldPostInput): Promise<{ id: string; error?: string }> {
    if (this.stopped) return { id: "0", error: "the field is closed" }
    if (hasLeft(memberOf(this.state, input.author))) return { id: "0", error: `${input.author} left the field` }
    const at = this.now()
    const mentions = this.resolveMentions(input.text, input.to)
    const limit = kindLimit(input.kind)
    const raw = input.text.replace(/\s+/g, " ").trim()
    // Structured evidence must never be cut. Prose can be clamped with the full
    // text kept in detail; a truncated fact is worse than a rejected one.
    const strict = ["fact", "finding", "dead-end", "test", "result", "oracle", "request", "claim"].includes(input.kind)
    if (raw.length > limit && strict) {
      return {
        id: "0",
        error: `too long by ${raw.length - limit} chars (limit ${limit}). Put the claim in text and the raw output in evidence[0].`,
      }
    }
    const text = raw.length > limit ? `${raw.slice(0, limit - 1).trimEnd()}…` : raw
    const overflow = raw.length > limit ? raw.slice(0, 64_000) : undefined

    if (input.kind === "fact") {
      const existing = duplicateFact(this.state, text)
      if (existing) {
        return { id: existing.id, error: `already on the board as ${existing.id}; add evidence there or contest it` }
      }
    }

    // Oracle: recon captures the baseline once and unlocks experiments.
    if (input.kind === "oracle") {
      const baseline = (input.evidence ?? [])[0] ?? input.baseline ?? ""
      if (baseline.trim().length === 0) return { id: "0", error: "oracle needs the baseline command/output in evidence[0]" }
      const baselineAt = input.baselineAt ?? at
      if (baselineAt < this.state.startedAt) {
        return {
          id: "0",
          error: "oracle baseline predates this field; capture the baseline again in this run",
        }
      }
      const scope = (input.scope ?? "").trim()
      if (/global|shared|historical/i.test(scope)) {
        return { id: "0", error: "oracle scope must name the process, file or path this field owns, not a global log" }
      }
      const oracle: Oracle = {
        observable: text,
        baseline,
        kind: input.oracleKind ?? this.state.oracle?.kind ?? "command",
        confirmed: true,
        source: input.author,
        capturedAt: at,
        baselineAt,
        scope: scope || `${input.author}:${input.oracleKind ?? "observation"}`,
        writer: input.writer?.trim() || undefined,
      }
      this.state = { ...this.state, oracle }
    }

    let experimentID: string | undefined
    if (input.kind === "test") {
      const started = startExperiment(this.state, {
        owner: input.author,
        lane: input.area,
        hypothesis: text,
        command: input.command ?? (input.evidence ?? [])[0] ?? "",
        expect: input.expect ?? "",
        killIf: input.killIf ?? "",
        preflight: input.preflight,
        baseline: input.baseline,
        evidence: input.evidence,
        now: at,
        maxExperiments: this.deps.maxExperiments ?? 0,
      })
      if (started.error || !started.experiment) return { id: "0", error: started.error ?? "test could not start" }
      this.state = started.state
      experimentID = started.experiment.id
    }

    if (input.kind === "result") {
      const experiment = (this.state.experiments ?? []).find((entry) => entry.id === (input.experiment ?? ""))
      if (experiment && experiment.owner !== input.author) {
        const owner = memberOf(this.state, experiment.owner)
        if (owner && ["left", "stopped", "failed", "done"].includes(owner.status)) {
          this.state = transferExperiment(this.state, {
            id: experiment.id,
            to: input.author,
            by: `the previous owner (${owner.status})`,
            now: at,
          })
        } else {
          return {
            id: "0",
            error: `${experiment.id} belongs to ${experiment.owner}; ask for a handoff before posting its result`,
          }
        }
      }
      const finished = finishExperiment(this.state, {
        owner: input.author,
        id: input.experiment ?? "",
        status: input.result ?? "fail",
        observed: input.observed,
        result: text,
        evidence: input.evidence,
        pidBefore: input.pidBefore,
        pidAfter: input.pidAfter,
        now: at,
      })
      if (finished.error || !finished.experiment) return { id: "0", error: finished.error ?? "result could not be recorded" }
      this.state = finished.state
      experimentID = finished.experiment.id
    }

    const posted = await this.deps.post({
      author: input.author,
      authorRole: "agent",
      kind: roomKindOf(input.kind),
      text,
      detail: input.detail ?? overflow ?? (input.observed ? input.observed.slice(0, 64_000) : undefined),
      to: "all",
      mentions,
      replyTo: input.replyTo,
      runID: this.state.id,
    })
    let state = notePost(this.state, input.author, input.kind, at, text)
    this.lastPost.set(input.author, clamp(text, 120))
    this.lastPulseAt = 0
    let answeredFrom: string | undefined
    if (input.replyTo) {
      const answered = (this.state.mentions ?? []).find(
        (mention) =>
          mention.id === input.replyTo &&
          mention.status === "open" &&
          (mention.to === input.author || mention.to === "all"),
      )
      if (answered) {
        state = answerMention(state, input.replyTo, posted.id)
        if (answered.senderWaits) answeredFrom = answered.from
      }
    }
    // Only a request or a question creates reply debt. A finding that names a
    // peer is attention, not an obligation.
    if (input.kind === "request" || input.kind === "question") {
      for (const target of mentions) {
        if (target === "all" || target === input.author) continue
        const targetMember = memberOf(state, target)
        if (!targetMember) continue
        // A left agent is gone for good; do not create reply debt for it.
        if (hasLeft(targetMember) || isSealed(targetMember.sessionID)) continue
        state = noteMention(state, {
          id: posted.id,
          from: input.author,
          to: target,
          text,
          at,
          replyBy: at + this.replyWindow(input.replyInSeconds),
          requiresReply: true,
          senderWaits: true,
        })
      }
    }
    let leaseConflict: { owner: string; area: string } | undefined
    if (input.kind === "claim") {
      state = noteClaim(state, {
        label: input.author,
        text,
        evidence: input.evidence ?? [],
        coverage: input.coverage,
        now: at,
      })
    } else {
      state = setMember(state, input.author, memberOf(state, input.author)?.status === "working" ? "working" : "idle")
    }
    if (input.kind === "fact" || input.kind === "dead-end") {
      const status: "observed" | "proposed" | "refuted" =
        input.kind === "dead-end" ? "refuted" : (input.evidence ?? []).length > 0 ? "observed" : "proposed"
      state = proposeFact(state, {
        id: posted.id,
        author: input.author,
        claim: text,
        evidence: input.evidence ?? [],
        area: input.area?.trim(),
        status,
        basedOn: input.basedOn,
        contradicts: input.contradicts,
        at,
      })
      if ((input.contradicts ?? []).length > 0) {
        state = openArbitration(state, { id: posted.id, at })
      }
    }
    if (input.kind === "result" && experimentID) {
      const experiment = (state.experiments ?? []).find((entry) => entry.id === experimentID)
      if (experiment && experiment.status !== "running") {
        state = proposeFact(state, {
          id: posted.id,
          author: input.author,
          claim: `${experiment.id} ${experiment.status}: ${experiment.hypothesis}`,
          evidence: [input.observed ?? "", ...(input.evidence ?? [])].filter(Boolean),
          area: input.area ?? experiment.lane,
          status: experiment.status === "pass" ? "proposed" : "refuted",
          at,
        })
      }
    }
    if (input.kind === "hypothesis") {
      const test = (input.evidence ?? [])[0] ?? text
      state = {
        ...state,
        hypotheses: [
          ...(state.hypotheses ?? []),
          {
            id: posted.id,
            statement: text,
            test,
            killIf: "",
            status: "open" as const,
            owner: input.author,
            timeBoxAt: at + Math.max(2, Math.min(15, input.leaseMinutes ?? 5)) * 60_000,
          },
        ].slice(-12),
      }
    }
    if (input.kind === "intent") {
      const area = (input.area ?? text).trim().slice(0, 120)
      if (area.length > 0) {
        const kind: "read" | "write" | "launch" =
          input.leaseKind === "read" || input.leaseKind === "launch" ? input.leaseKind : "write"
        const granted = grantLease(state, {
          owner: input.author,
          area,
          kind,
          paths: input.paths && input.paths.length > 0 ? input.paths : [area],
          now: at,
          ttlMs: clampNumber(input.leaseMinutes, this.deps.intentLeaseMs / 60_000, 1, 60) * 60_000,
        })
        state = granted.state
        leaseConflict = granted.conflict
      }
    }
    if (input.kind === "handoff") {
      // Handoff releases the owner's leases, not just one exact area string.
      if (input.experiment) {
        const to = Array.isArray(input.to)
          ? input.to.find((label) => memberOf(state, label) && label !== input.author)
          : undefined
        if (to) {
          state = transferExperiment(state, { id: input.experiment, to, by: input.author, now: at })
        }
      }
      state = releaseLease(state, { owner: input.author, now: at })
      state = releaseIntent(state, { owner: input.author, now: at })
    }
    if (input.kind === "lesson") {
      const active = runningExperiment(state)
      if (!active) state = noteLesson(state, { label: input.author, text, at })
    }
    this.state = noteProgress(state, at)
    await this.save()
    const arbitration = (this.state.arbitrations ?? []).find(
      (entry) => entry.status === "open" && entry.factIDs.includes(posted.id),
    )
    if (arbitration) {
      const notice = `Arbitration ${arbitration.id}: ${arbitration.owner}, run one decisive check within ${Math.round(
        (arbitration.deadlineAt - at) / 60_000,
      )}m. ${arbitration.test}`
      const call = await this.deps.post({
        author: "System",
        authorRole: "system",
        kind: "system",
        text: notice,
        mentions: [arbitration.owner],
        runID: this.state.id,
      })
      await this.fanout({
        id: call.id,
        author: "System",
        authorRole: "system",
        kind: "status",
        text: notice,
        to: "all",
        mentions: [arbitration.owner],
        at,
      })
    }
    await this.fanout({
      id: posted.id,
      author: input.author,
      authorRole: "agent",
      kind: input.kind,
      text,
      to: "all",
      mentions,
      area: input.area,
      replyTo: input.replyTo,
      experiment: experimentID,
      at,
    })
    if (answeredFrom && memberOf(this.state, answeredFrom)?.status === "idle") {
      void this.flush(answeredFrom).catch(() => undefined)
    }
    if (leaseConflict) {
      const notice = `Lease refused for ${input.author}: ${leaseConflict.owner} holds ${leaseConflict.area}. Release it or ask for a handoff; do not retry the same write.`
      const denied = await this.deps.post({
        author: "System",
        authorRole: "system",
        kind: "system",
        text: notice,
        mentions: [input.author, leaseConflict.owner],
        runID: this.state.id,
      })
      await this.fanout({
        id: denied.id,
        author: "System",
        authorRole: "system",
        kind: "status",
        text: notice,
        to: "all",
        mentions: [input.author, leaseConflict.owner],
        at,
      })
    } else if (input.kind === "intent") {
      await this.warnOverlap(input.author, (input.area ?? text).trim().slice(0, 120))
    }
    if (input.kind === "claim") await this.closeGate(input.author)
    return { id: posted.id }
  }

  /**
   * Check a principal message before it is written to the room. The service
   * calls this first so an over-budget order is never recorded as if delivered.
   */
  checkPrincipal(
    message: Pick<RoomMessage, "authorRole" | "kind" | "text" | "to" | "mentions" | "order">,
  ): string | undefined {
    if (this.stopped) return "the field is closed"
    if (message.authorRole !== "orchestrator") return undefined
    const isOrder = message.order === true || message.kind === "order" || message.kind === "goal"
    const now = this.now()
    const text = message.text.replace(/\s+/g, " ").trim()
    if (this.state.sameRole && isOrder) {
      return "This is an independent same-role room. Post a fact, a dead-end, or a direct ask instead of ordering a peer."
    }
    const cap = this.deps.maxCoordinatorOrders ?? 16
    if (isOrder && (this.state.orders ?? 0) >= cap) {
      return `order budget spent (${cap}). Use a plain chat (no order flag) or let the room self-direct.`
    }
    const min = this.deps.coordinatorMinIntervalMs ?? 30_000
    if (this.lastPrincipalAt > 0 && now - this.lastPrincipalAt < min && message.kind !== "goal") {
      const wait = Math.ceil((min - (now - this.lastPrincipalAt)) / 1_000)
      return `one decision per ${Math.round(min / 1_000)}s. Wait ${wait}s, then send one owner/action/expected output.`
    }
    const maxChars = this.deps.coordinatorMaxChars ?? 600
    if (text.length > maxChars) {
      return `too long by ${text.length - maxChars} chars. One owner, one action, one expected output; put the rest on the board.`
    }
    const mentions = [...new Set([...this.resolveMentions(text, message.to === "all" ? undefined : message.to), ...message.mentions])]
    if (isOrder && message.to === "all" && mentions.length === 0 && message.kind !== "goal") {
      return "name one owner. A broadcast directive creates six interpretations and no action."
    }
    return undefined
  }

  /** A message already posted by the service (user chat, goal, order). */
  async publish(message: RoomMessage): Promise<{ ok: boolean; error?: string }> {
    if (this.stopped) return { ok: false, error: "the field is closed" }
    const rejection = this.checkPrincipal(message)
    if (rejection) return { ok: false, error: rejection }
    const mentions = [...new Set([...this.resolveMentions(message.text, message.to === "all" ? undefined : message.to), ...message.mentions])]
    const at = this.now()
    const isOrder = message.authorRole === "orchestrator" && (message.order === true || message.kind === "order" || message.kind === "goal")
    if (isOrder) {
      this.state = { ...this.state, orders: (this.state.orders ?? 0) + 1 }
    }
    if (message.authorRole === "orchestrator" && message.kind !== "goal") this.lastPrincipalAt = at
    // Agent messages create reply debt only for an actual ask.
    if (message.authorRole === "agent" && (message.kind === "request" || message.kind === "question")) {
      for (const target of mentions) {
        if (target === "all" || target === message.author) continue
        const targetMember = memberOf(this.state, target)
        if (!targetMember) continue
        if (!this.mayWake(targetMember, message.authorRole, message.order === true, true)) continue
        this.state = noteMention(this.state, {
          id: message.id,
          from: message.author,
          to: target,
          text: message.text,
          at,
          replyBy: at + this.replyWindow(),
          requiresReply: true,
          senderWaits: true,
        })
      }
    }
    this.lastPulseAt = 0
    await this.save()
    const files = (message.meta?.attachments ?? []).map((attachment) => ({
      data: attachment.data,
      mime: attachment.mime,
      name: attachment.name,
    }))
    await this.fanout({
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      kind: "note",
      text: message.text,
      to: "all",
      mentions,
      files,
      order: message.order === true || message.kind === "order" || message.kind === "goal",
      principal: message.authorRole === "user" || message.authorRole === "orchestrator",
      at: message.at,
    })
    if (message.authorRole === "user" || message.order === true || message.kind === "order" || message.kind === "goal") {
      await this.pumpCoordinator(true)
    }
    return { ok: true }
  }

  private async warnOverlap(owner: string, area: string): Promise<void> {
    const clean = area.toLowerCase()
    if (clean.length === 0) return
    const now = this.now()
    const overlaps = activeIntents(this.state, now).filter((intent) => {
      if (intent.owner === owner) return false
      const other = intent.area.toLowerCase()
      return clean === other || clean.startsWith(`${other}/`) || other.startsWith(`${clean}/`)
    })
    if (overlaps.length === 0) return
    const names = [owner, ...overlaps.map((intent) => intent.owner)]
    const text = `Overlap: ${names.join(" and ")} both claim ${area}. Negotiate a split or a sequence before editing.`
    const posted = await this.deps.post({
      author: "System",
      authorRole: "system",
      kind: "system",
      text,
      mentions: [...new Set(names)],
      runID: this.state.id,
    })
    await this.fanout({ id: posted.id, author: "System", authorRole: "system", kind: "status", text, to: "all", mentions: names, at: now })
  }

  private async expireCoordination(now: number): Promise<void> {
    const before = this.state
    const expiredMentions = (before.mentions ?? []).filter(
      (mention) =>
        mention.status === "open" &&
        ((mention.delivery !== "pending" && mention.replyBy <= now) ||
          (mention.delivery === "pending" && mention.at <= now - 10 * 60_000)),
    )
    this.state = expireIntents(expireMentions(this.state, now), now)
    if (this.state === before) return
    await this.save()
    for (const mention of expiredMentions) {
      const sender = memberOf(this.state, mention.from)
      const target = memberOf(this.state, mention.to)
      if (!sender || ["done", "stopped", "failed"].includes(sender.status)) continue
      if (isSealed(sender.sessionID) || (target && isSealed(target.sessionID))) continue
      // No room notice: the asker simply continues. The expiry is already on the
      // board, and a broadcast "mention expired" is pure noise.
      const text = mentionExpiredPrompt({ target: mention.to, objective: this.state.contract.objective })
      if (sender.status === "idle" && !this.busy.has(sender.label)) {
        await this.beginTurn(sender, text)
      } else if (sender.sessionID) {
        await this.deps.prompt(sender.sessionID, text, { delivery: "queue", resume: true }).catch(() => undefined)
      }
    }
    // An expired area lease is already filtered by activeIntents; a room notice
    // only buys another line nobody acts on.
  }

  private async pulse(reason: string): Promise<void> {
    const now = this.now()
    const text = `Room is quiet. Anyone with a new fact, a result, or a route to close should speak now. ${reason}`.trim()
    this.lastPulseAt = now
    const posted = await this.deps
      .post({
        author: FOREMAN_NAME,
        authorRole: "system",
        kind: "system",
        text,
        runID: this.state.id,
      })
      .catch(() => undefined)
    this.queueCoordinator({
      id: posted?.id ?? "pulse",
      author: FOREMAN_NAME,
      role: "system",
      kind: "system",
      text,
      at: now,
      order: false,
      mentions: [],
    })
    // Vera may ask the room a question, but she does not wake an idle agent.
    // Waking is the coordinator's job. Working agents still see the pulse now.
    const working = this.state.members.filter((member) => member.status === "working" && !isSealed(member.sessionID))
    await Promise.all(
      working.map((member) =>
        this.deps
          .prompt(
            member.sessionID,
            pulsePrompt({ objective: this.state.contract.objective, quietSeconds: this.deps.quietMs / 1_000 }),
            { delivery: "steer", resume: true },
          )
          .catch(() => undefined),
      ),
    )
  }

  async noteTurnStart(sessionID: string): Promise<void> {
    const member = this.memberBySession(sessionID)
    if (!member || this.stopped || hasLeft(member) || isSealed(member.sessionID)) return
    if (member.status === "working") return
    // The context hook fires on every model request, so it must not count a
    // turn. Turns are counted when the driver (or an order) starts one.
    this.state = setMember(this.state, member.label, "working")
    await this.save()
  }

  async noteIdle(sessionID: string): Promise<void> {
    const member = this.memberBySession(sessionID)
    if (!member || hasLeft(member)) return
    if (member.status === "working") await this.settle(member.label)
    if (pending(this.inbox, member.label) === 0) return
    if (openMentionFrom(this.state, member.label, this.now()) && !this.pendingHasMention(member.label)) return
    await this.flush(member.label)
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    const status = this.state.status
    if (status !== "running") return
    if (this.deps.cancelled()) return
    this.ticking = true
    try {
      const now = this.now()
      // An explicit deadline is still a User choice. The default is 0, which
      // means the field never forces anyone out.
      if (deadlineReached(this.state, now)) {
        await this.stop("deadline", "the User-set time budget ran out")
        return
      }
      // A working owner keeps its lease. Static analysis can easily outlive a
      // short TTL, and stealing that area causes duplicate experiments.
      const working = this.state.members.filter((member) => member.status === "working").map((member) => member.label)
      if (working.length > 0) {
        this.state = heartbeatIntents(this.state, working, now, this.deps.intentLeaseMs)
      }
      const lag = this.lagging(now)
      if (lag) {
        await this.recoverLag(lag, now)
        return
      }
      const modelLag = await this.modelLagging(now)
      if (modelLag) {
        await this.recoverModelLag(modelLag, now)
        return
      }
      await this.veraScan(now)
      // A turn that ended while no idle hook fired must not leave a member
      // "working" for ever: the host already knows the session finished.
      const adoptGrace = this.adoptedAt > 0 && now - this.adoptedAt < 45_000
      for (const member of [...this.state.members]) {
        if (member.status !== "working" || adoptGrace) continue
        const info = await this.deps.info(member.sessionID).catch(() => undefined)
        if (info?.outcome === "succeeded" || info?.outcome === "failed" || info?.outcome === "interrupted") {
          await this.settle(member.label)
        }
      }
      await this.expireCoordination(now)
      for (const member of [...this.state.members]) {
        if (member.status !== "idle" || hasLeft(member) || isSealed(member.sessionID)) continue
        if (openMentionFrom(this.state, member.label, now)) {
          if (this.pendingHasMention(member.label)) await this.flush(member.label)
          continue
        }
        const queued = pending(this.inbox, member.label)
        if (
          queued > 0 &&
          shouldFlush({
            queued,
            working: false,
            now,
            lastActivityAt: this.lastActivity(member),
            debounceMs: this.deps.flushDelayMs,
          })
        ) {
          await this.flush(member.label)
        }
      }
      if (allLeft(this.state)) {
        this.state = finishField(this.state, "all-left", "every agent left the field", now)
        await this.save()
        return
      }
      // Advisory only. The field never closes itself; it tells the room that
      // the route may be exhausted and lets each agent decide to leave.
      const quietFor = now - (this.state.lastProgressAt ?? this.state.startedAt)
      const noProgressAt = (this.deps.maxNoProgressMinutes ?? 0) * 60_000
      if (
        noProgressAt > 0 &&
        quietFor >= noProgressAt &&
        now - (this.state.progressNotifiedAt ?? 0) >= noProgressAt
      ) {
        this.state = { ...this.state, progressNotifiedAt: now }
        await this.save()
        const minutes = Math.round(quietFor / 60_000)
        const notice = `No new evidence for ${minutes}m. Post a result, close the route, or leave with arena_bus action=leave. The field will not force you out.`
        await this.deps
          .post({
            author: FOREMAN_NAME,
            authorRole: "system",
            kind: "system",
            text: notice,
            runID: this.state.id,
          })
          .catch(() => undefined)
        // Convergence is a direct ask, not just a room notice. Each seat gets
        // one final-report prompt at its next safe point.
        const converge = `[arena.converge] No new evidence for ${minutes}m. If the goal is met, post kind=claim with the evidence; if it is not, post one concrete dead-end and leave with arena_bus action=leave. Do not start a new front. Only the User can stop the field.`
        for (const member of this.state.members) {
          if (hasLeft(member) || isSealed(member.sessionID)) continue
          await this.deps
            .prompt(member.sessionID, converge, { delivery: "steer", resume: true })
            .catch(() => undefined)
        }
      }
      await this.check()
      await this.pumpCoordinator()
    } finally {
      this.ticking = false
    }
  }

  /** One silent turn that returns the agent's final text, counted as a turn. */
  private async ask(member: FieldMember, text: string): Promise<string> {
    if (this.busy.has(member.label) || this.stopped || isSealed(member.sessionID)) return ""
    this.busy.add(member.label)
    try {
      this.state = noteTurn(this.state, member.label, this.now())
      await this.save()
      try {
        await this.deps.prompt(member.sessionID, text)
        await this.deps.wait(member.sessionID, this.deps.turnTimeoutMs)
      } catch {
        return ""
      }
      return (await this.deps.finalText(member.sessionID).catch(() => undefined)) ?? ""
    } finally {
      this.busy.delete(member.label)
      await this.settle(member.label)
    }
  }

  private async askForeman(text: string): Promise<string> {
    const sessionID = this.state.foremanSessionID
    if (!sessionID || isSealed(sessionID)) return ""
    try {
      await this.deps.prompt(sessionID, text)
      const outcome = await this.deps.wait(sessionID, this.deps.foremanTimeoutMs)
      if (outcome === "timeout") await this.deps.interrupt(sessionID).catch(() => undefined)
      return (await this.deps.finalText(sessionID).catch(() => undefined)) ?? ""
    } catch {
      return ""
    }
  }

  /** The oldest running job, so a 20-minute stall is visible before the kill. */
  private healthLine(now: number): string {
    if (!this.deps.jobFor) return ""
    let oldest: { label: string; id: string; startedAt: number; foreground?: boolean } | undefined
    for (const member of this.state.members) {
      if (member.status === "left") continue
      const job = this.deps.jobFor(member.label)
      if (!job) continue
      if (!oldest || job.startedAt < oldest.startedAt) oldest = { label: member.label, ...job }
    }
    if (!oldest) return ""
    const age = Math.max(0, Math.round((now - oldest.startedAt) / 1_000))
    return `${oldest.label} ${oldest.id} ${age}s ${oldest.foreground === false ? "background" : "foreground"}`
  }

  private markCardSeen(label: string): void {
    this.state = {
      ...this.state,
      members: this.state.members.map((member) =>
        member.label === label ? { ...member, cardSeen: true } : member,
      ),
    }
  }

  private cardFor(member: FieldMember, delta: string): string {
    const health = this.healthLine(this.now())
    if (this.state.sameRole && member.cardSeen === true) {
      return deltaCard(this.state, member.label, this.now(), delta, health)
    }
    return `${stateCard(this.state, member.label, this.now(), health)}\n\n${delta}`
  }

  /**
   * A seat marked `working` is not proof that it is alive. A foreground
   * `arena_exec` can leave a grandchild holding the run lock, and the host then
   * never fires the idle hook. The job record is the heartbeat we can trust.
   */
  private lagging(now: number): { member: FieldMember; job: { id: string; startedAt: number } } | undefined {
    if (!this.deps.jobFor) return undefined
    const limit = this.deps.stallAfterMs ?? 150_000
    for (const member of this.state.members) {
      if (member.status !== "working" || hasLeft(member)) continue
      const job = this.deps.jobFor(member.label)
      if (!job || job.foreground === false) continue
      if (now - job.startedAt >= limit) return { member, job }
    }
    return undefined
  }

  private async recoverLag(
    lag: { member: FieldMember; job: { id: string; startedAt: number } },
    now: number,
  ): Promise<void> {
    await this.deps.stopJob?.(lag.job.id)
    await this.deps.interrupt(lag.member.sessionID).catch(() => undefined)
    this.state = setMember(this.state, lag.member.label, "idle")
    await this.save()
    const minutes = Math.max(1, Math.round((now - lag.job.startedAt) / 60_000))
    await this.verdict(
      `${lag.member.label} was stuck in ${lag.job.id} for ${minutes}m; stopped the process tree and released the run lock.`,
    )
    this.lastVeraPostAt = now
  }

  /** A model turn can also hang without a job. The host's last update is the signal. */
  private async modelLagging(now: number): Promise<{ member: FieldMember; lastAt: number } | undefined> {
    const limit = (this.deps.stallAfterMs ?? 150_000) * 2
    for (const member of this.state.members) {
      if (member.status !== "working" || hasLeft(member)) continue
      if (this.deps.jobFor?.(member.label)) continue
      const info = await this.deps.info(member.sessionID).catch(() => undefined)
      if (!info?.updatedAt) continue
      if (now - info.updatedAt >= limit) return { member, lastAt: info.updatedAt }
    }
    return undefined
  }

  private async recoverModelLag(lag: { member: FieldMember; lastAt: number }, now: number): Promise<void> {
    await this.deps.interrupt(lag.member.sessionID).catch(() => undefined)
    this.state = setMember(this.state, lag.member.label, "idle")
    await this.save()
    const minutes = Math.max(1, Math.round((now - lag.lastAt) / 60_000))
    await this.verdict(
      `${lag.member.label} had no host activity for ${minutes}m; interrupted the stalled turn. The seat is idle and can continue.`,
    )
    this.lastVeraPostAt = now
  }

  /**
   * Vera's deterministic checks. These do not need a model turn: a stale lease,
   * a stuck experiment and a phase decision are facts the driver can see.
   */
  private async veraScan(now: number): Promise<boolean> {
    if (now - this.lastVeraPostAt < 120_000) return false
    const staleAfter = Math.max(this.deps.intentLeaseMs, 600_000)
    const stale = activeIntents(this.state, now).find((intent) => {
      const owner = memberOf(this.state, intent.owner)
      if (!owner || owner.status === "working" || owner.status === "left") return false
      return intent.kind !== "read" && now - (intent.heartbeatAt ?? intent.at) > staleAfter
    })
    if (stale) {
      this.state = releaseLease(this.state, { owner: stale.owner, token: stale.token, now })
      const text = `${stale.owner}'s lease on ${stale.area} expired after ${Math.round(staleAfter / 60_000)}m idle; the area is free.`
      await this.verdict(text)
      this.lastVeraPostAt = now
      return true
    }
    const stuck = runningExperiment(this.state)
    const stuckOwner = stuck ? memberOf(this.state, stuck.owner) : undefined
    if (stuck && stuckOwner?.status !== "working" && now - (stuck.startedAt ?? now) > 15 * 60_000) {
      this.state = {
        ...this.state,
        experiments: (this.state.experiments ?? []).map((experiment) =>
          experiment.id === stuck.id
            ? { ...experiment, status: "invalid" as const, endedAt: now, result: "no result within 15m; marked invalid" }
            : experiment,
        ),
      }
      await this.save()
      await this.verdict(`${stuck.id} by ${stuck.owner} produced no result in 15m; marked invalid, the slot is free.`)
      this.lastVeraPostAt = now
      return true
    }
    return false
  }

  private async verdict(text: string): Promise<void> {
    const posted = await this.deps.post({
      author: FOREMAN_NAME,
      authorRole: "system",
      kind: "verdict",
      text,
      runID: this.state.id,
    })
    this.queueCoordinator({
      id: posted.id,
      author: FOREMAN_NAME,
      role: "system",
      kind: "verdict",
      text,
      at: this.now(),
      order: false,
      mentions: [],
    })
    await this.fanout({
      id: posted.id,
      author: FOREMAN_NAME,
      authorRole: "system",
      kind: "verdict",
      text,
      to: "all",
      at: this.now(),
    })
  }

  protected async check(force = false): Promise<void> {
    if (this.stopped || this.state.status !== "running" || !this.state.foremanSessionID) return
    if (this.state.maxForemanTurns > 0 && this.state.foremanTurns >= this.state.maxForemanTurns) return
    const now = this.now()
    const elapsed = now - this.state.lastCheckAt
    const openMentions = (this.state.mentions ?? []).filter(
      (mention) => mention.status === "open" && mention.replyBy > now,
    )
    const active = this.state.members.filter((member) => !hasLeft(member))
    // Healthy work is not a reason to spend a referee turn. The deterministic
    // lag scan already watches every foreground job; Vera is for a stalled,
    // idle or contested room, not for a heartbeat while everyone is working.
    if (!force && active.length > 0 && active.every((member) => member.status === "working") && openMentions.length === 0) {
      return
    }
    // An all-idle room used to bypass the interval on every tick, which called
    // Vera every few seconds for hours. The interval is the floor; idle is a
    // reason to check at that floor, not a reason to spin.
    if (!force && elapsed < this.state.checkEveryMs) return
    // After the convergence prompt has already fired, an idle room waiting for
    // the User does not need another model call. Keep the field live, but quiet.
    const quietFor = now - (this.state.lastProgressAt ?? this.state.startedAt)
    const noProgressAt = (this.deps.maxNoProgressMinutes ?? 0) * 60_000
    if (
      !force &&
      noProgressAt > 0 &&
      this.state.progressNotifiedAt &&
      quietFor >= noProgressAt * 2 &&
      active.length > 0 &&
      active.every((member) => member.status === "idle")
    ) {
      return
    }
    // One honest close recommendation is enough for five minutes. Repeating it
    // every interval while the same condition persists is pure noise.
    if (
      !force &&
      (this.state.lastRefereeDecision === "report" || this.state.lastRefereeDecision === "abort") &&
      now - (this.state.lastRefereeAt ?? 0) < 5 * 60_000
    ) {
      return
    }
    // A recommendation is not a new event. Do not re-ask Vera every interval
    // when nothing has changed and she already said "report".
    if (
      !force &&
      (this.state.lastRefereeDecision === "report" || this.state.lastRefereeDecision === "abort") &&
      this.state.posts === this.postsAtCheck
    ) return
    this.state = noteCheck(this.state, now)
    this.postsAtCheck = this.state.posts
    await this.save()
    const cap = this.state.maxForemanTurns > 0 ? `${this.state.foremanTurns}/${this.state.maxForemanTurns}` : `${this.state.foremanTurns} (no cap)`
    const prompt = refereePrompt({
      board: boardText({ state: this.state, lastPost: Object.fromEntries(this.lastPost), now }),
      budgetLine: `Elapsed: ${Math.round((now - this.state.startedAt) / 60_000)}m. ${
        this.state.deadlineAt > 0
          ? `User budget: ${Math.round((this.state.deadlineAt - this.state.startedAt) / 60_000)}m.`
          : "No deadline; the field runs until the User stops it or every agent leaves."
      } Referee checks used: ${cap}.`,
    })
    let decision = parseReferee(await this.askForeman(prompt))
    if (!decision) {
      const reply = await this.askForeman("Return only the JSON object with action continue, pulse or abort. No prose.")
      decision = parseReferee(reply)
    }
    if (!decision) return
    this.state = noteReferee(this.state, decision.action, now)
    await this.save()
    if (decision.action === "report" || decision.action === "abort") {
      // Vera may recommend a close, but she may not force agents out. Only the
      // User can stop the field; agents leave by their own decision.
      await this.deps
        .post({
          author: FOREMAN_NAME,
          authorRole: "system",
          kind: "verdict",
          text: `Vera recommends a close: ${decision.reason ?? "the remaining routes look exhausted"}. The field stays live; each agent may report or leave, and only the User can stop it.`,
          runID: this.state.id,
        })
        .catch(() => undefined)
      return
    }
    if (decision.action === "pulse") {
      if (this.lastPulseAt > 0 && now - this.lastPulseAt < this.deps.quietMs * 4) return
      await this.pulse(decision.reason ?? "the room is quiet")
    }
  }

  protected async closeGate(label: string): Promise<void> {
    // Gates serialize: a second claim waits for the first decision.
    this.gateChain = this.gateChain.then(() => this.runGate(label)).catch(() => undefined)
    await this.gateChain
  }

  private async runGate(label: string): Promise<void> {
    if (this.stopped || this.state.status !== "running") return
    const claim = [...this.state.claims].reverse().find((entry) => entry.label === label)
    if (!claim) return
    // A coverage claim is deliberately partial: it reports what the field
    // proved and where the boundary is, so the objective's end-to-end command
    // is not the right gate for it.
    const coverage = (claim.coverage ?? []).filter((item) => item.trim().length > 0)
    const command = coverage.length > 0 ? undefined : this.state.contract.verificationCommand
    let verification: { ok: boolean; output: string } | undefined
    if (command) {
      try {
        verification = await this.deps.verify(command, label, this.deps.verifyTimeoutMs)
      } catch (error) {
        verification = { ok: false, output: error instanceof Error ? error.message : String(error) }
      }
    }
    let falsifier: { falsified: boolean; reason: string; test?: string } | undefined
    const peer = this.state.members.find(
      (member) =>
        member.label !== label &&
        member.status === "idle" &&
        !hasLeft(member) &&
        !this.busy.has(member.label) &&
        !isSealed(member.sessionID),
    )
    if (peer) {
      const text = await this.ask(peer, falsifyPrompt({ contract: this.state.contract, claim }))
      const raw = extractJSON(text)
      const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
      if (record) {
        falsifier = {
          falsified: record.falsified === true,
          reason: typeof record.reason === "string" ? record.reason : "",
          test: typeof record.test === "string" ? record.test : undefined,
        }
      }
    }
    const result = judgeClaim({
      claim: { label, text: claim.text, evidence: claim.evidence, coverage },
      attempts: claim.attempts,
      hasCommand: Boolean(command),
      verification,
      falsifier,
      maxAttempts: 2,
    })
    const decision = result.accepted ? "accepted" : "rejected"
    const detail = [
      claim.text,
      ...claim.evidence,
      coverage.length > 0 ? `coverage: ${coverage.join(" | ")}` : "",
      verification ? `verification: ${verification.ok ? "PASS" : "FAIL"} ${verification.output.slice(0, 400)}` : "",
      falsifier ? `peer check: ${falsifier.falsified ? "falsified" : "not falsified"}: ${falsifier.reason}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    const verdictText = `${decision} ${label}: ${result.reason}`
    const verdict = await this.deps.post({
      author: FOREMAN_NAME,
      authorRole: "system",
      kind: "verdict",
      text: verdictText,
      detail,
      runID: this.state.id,
    })
    this.queueCoordinator({
      id: verdict.id,
      author: FOREMAN_NAME,
      role: "system",
      kind: "verdict",
      text: verdictText,
      at: this.now(),
      order: false,
      mentions: [],
    })
    if (result.accepted && this.state.sameRole) {
      // Same-role rooms are independent runs. A solution is shared with the
      // room, but it does not force the other agents out; each leaves on its own.
      this.state = {
        ...this.state,
        claims: this.state.claims.map((entry) =>
          entry.label === label && entry.at === claim.at ? { ...entry, accepted: true } : entry,
        ),
        notes: [...this.state.notes, `solution accepted from ${label}: ${claim.text}`],
      }
      await this.save()
      const text = `Solution accepted from ${label}: ${claim.text}. It is in the shared room; the field stays live. Verify it, use it, or leave on your own decision.`
      await this.deps
        .post({
          author: FOREMAN_NAME,
          authorRole: "system",
          kind: "verdict",
          text,
          runID: this.state.id,
        })
        .catch(() => undefined)
      await this.fanout({
        id: verdict.id,
        author: FOREMAN_NAME,
        authorRole: "system",
        kind: "verdict",
        text,
        to: "all",
        at: this.now(),
      })
      return
    }
    if (result.accepted) {
      this.state = acceptField(this.state, {
        label,
        reason: result.reason,
        evidence: claim.evidence.join("; "),
        now: this.now(),
      })
      this.stopped = true
      for (const member of this.state.members) {
        if (member.status === "working") {
          await this.deps
            .prompt(
              member.sessionID,
              `[arena.verdict] The field is closed: the claim by ${label} was accepted. Stop working at the next safe point; do not change the workspace after this verdict.`,
              { delivery: "steer" },
            )
            .catch(() => undefined)
        }
        await this.deps.interrupt(member.sessionID).catch(() => undefined)
        if (member.status !== "left" && member.status !== "stopped" && member.status !== "failed") {
          this.state = setMember(this.state, member.label, "done")
        }
      }
      if (this.state.foremanSessionID) {
        await this.deps.interrupt(this.state.foremanSessionID).catch(() => undefined)
      }
      await this.save()
      const text = `Field ${this.state.id} closed: the claim by ${label} was accepted. All agents stopped; start a new field to continue.`
      await this.deps
        .post({
          author: "System",
          authorRole: "system",
          kind: "lifecycle",
          text,
          runID: this.state.id,
        })
        .catch(() => undefined)
      await this.finalNotice({
        id: "verdict",
        author: "System",
        role: "system",
        kind: "lifecycle",
        text: `${text} Verification: ${result.reason}. Answer the User now.`,
        at: this.now(),
        order: false,
        mentions: [],
      })
      return
    }
    this.state = rejectClaim(this.state, label)
    if (result.final) this.state = setMember(this.state, label, "done")
    await this.save()
    const claimer = memberOf(this.state, label)
    if (claimer && !result.final) {
      await this.deps
        .prompt(claimer.sessionID, claimRejectedPrompt({ reason: result.reason }), { delivery: "queue", resume: true })
        .catch(() => undefined)
    }
  }

  /** Stop this driver without posting anything; a hot reload is taking over. */
  detach(): void {
    this.stopped = true
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
  }

  async stop(
    reason: "stopped" | "deadline" | "failed" | "aborted" | "reported",
    note = "",
    notifyCoordinator = true,
  ): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
    this.state = finishField(this.state, reason, note, this.now())
    this.state = { ...this.state, report: buildReport(this.state) }
    for (const member of this.state.members) {
      // Interrupt even an agent whose stored status looks idle: a hot-reload
      // handover can leave a turn in flight that the state does not show.
      await this.deps.interrupt(member.sessionID).catch(() => undefined)
      if (member.status !== "failed" && member.status !== "left") {
        this.state = setMember(this.state, member.label, "stopped")
      }
    }
    if (this.state.foremanSessionID) {
      await this.deps.interrupt(this.state.foremanSessionID).catch(() => undefined)
    }
    await this.save()
    await Promise.resolve(this.deps.remember?.(this.state)).catch(() => undefined)
    await Promise.resolve(this.deps.cleanup?.(this.state.members)).catch(() => undefined)
    const text = `Field ${this.state.id} closed (${reason}): all agents stopped. Start a new field to continue.${
      this.state.report ? ` Report: ${this.state.report.outcome}. ${this.state.report.reason}` : ""
    }`
    await this.deps
      .post({
        author: "System",
        authorRole: "system",
        kind: "lifecycle",
        text,
        runID: this.state.id,
      })
      .catch(() => undefined)
    if (notifyCoordinator) {
      await this.finalNotice({
        id: "closed",
        author: "System",
        role: "system",
        kind: "lifecycle",
        text: `${text}${note ? ` Reason: ${note}.` : ""} The field is closed. Do not run shell, read, edit, browser or subagent tools. Answer the User with the final report now.`,
        at: this.now(),
        order: false,
        mentions: [],
      })
    }
  }

  /**
   * A conflict guard for the tools that can actually collide: file writes,
   * patches, process launches and kills. It does not demand a lease for every
   * read; it blocks a second writer or launcher on a resource another member
   * already owns.
   */
  guardTool(
    sessionID: string,
    tool: string,
    input: unknown,
  ): { allowed: boolean; reason?: string } {
    const member = this.memberBySession(sessionID)
    if (!member || this.stopped) return { allowed: true }
    if (hasLeft(member) || isSealed(member.sessionID)) {
      return { allowed: false, reason: `${member.label} has left the field; no tool may wake it again.` }
    }
    const name = tool.toLowerCase()
    const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const path =
      typeof record.filePath === "string"
        ? record.filePath
        : typeof record.file_path === "string"
          ? record.file_path
          : typeof record.path === "string"
            ? record.path
            : ""
    const command = typeof record.command === "string" ? record.command : ""
    const isWrite = /^(write|edit|patch|apply)$/.test(base)
    // A launch is the verb, not the target's name. `Get-Process Acrobat` and
    // `Get-ChildItem "...\Acrobat DC"` are reads and must never be fenced by a
    // launch lease.
    const launchVerb =
      /^\s*(?:&\s*)?(?:start-process|start\b|\.\\|["']?[a-z]:\\[^"']+\.(?:exe|bat|cmd|ps1)|taskkill|stop-process|kill\b|frida(?:-server)?\b|wmic\s+process\s+call\s+create|invoke-expression|iex\b)|powershell[^\n]*\s-file\s+|frida(?:-server)?\s+-f\b/i
    const isLaunch = /^(shell|bash|execute|arena_exec)$/.test(base) && launchVerb.test(command)
    if (!isWrite && !isLaunch) return { allowed: true }

    // Copy-on-write is enforced for the file tools: a write to the shared
    // baseline is refused; the member must edit its own copy and publish it.
    if (isWrite && this.state.copyOnWrite && this.state.workspaceRoot && member.workspacePath && path) {
      const norm = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
      const wanted = norm(path)
      const shared = norm(this.state.workspaceRoot)
      const own = norm(member.workspacePath)
      if (wanted.startsWith(shared) && !wanted.startsWith(own)) {
        return {
          allowed: false,
          reason: `copy-on-write: ${path} is in the shared baseline. Copy it into your own tree (${member.workspacePath}) and edit there.`,
        }
      }
    }

    const now = this.now()
    const others = activeIntents(this.state, now).filter(
      (intent) =>
        intent.owner !== member.label &&
        (intent.kind === "write" || intent.kind === "launch") &&
        (isLaunch ? intent.kind === "launch" || intent.kind === "write" : intent.kind === "write"),
    )
    // A script can start a GUI without naming the target in its argv. When the
    // launch goes through arena_exec, any live launch lease owned by a peer is
    // enough to fence it: only one seat may drive the host target at a time.
    if (isLaunch && base === "arena_exec") {
      const launch = others.find((intent) => intent.kind === "launch")
      if (launch) {
        return {
          allowed: false,
          reason: `${launch.owner} holds the launch lease on ${launch.area}. Release it before starting another host process.`,
        }
      }
    }
    const wanted = (path || command).replace(/\//g, "\\").toLowerCase()
    if (wanted.length === 0) return { allowed: true }
    const hit = others.find((intent) => {
      const paths = (intent.paths && intent.paths.length > 0 ? intent.paths : [intent.area]).map((value) =>
        value.replace(/\//g, "\\").toLowerCase(),
      )
      return paths.some(
        (candidate) =>
          wanted.includes(candidate) ||
          candidate.includes(wanted) ||
          (intent.area.length > 0 && command.toLowerCase().includes(intent.area.toLowerCase())),
      )
    })
    if (!hit) return { allowed: true }
    return {
      allowed: false,
      reason: `${hit.owner} holds a ${hit.kind ?? "write"} lease on ${hit.area}. Negotiate a split, a sequence, or a handoff before touching it.`,
    }
  }

  async resolveArbitration(id: string, result: string): Promise<string> {
    const arbitration = (this.state.arbitrations ?? []).find((entry) => entry.id === id)
    if (!arbitration) return `No arbitration ${id}.`
    if (arbitration.status !== "open") return `Arbitration ${id} is already ${arbitration.status}.`
    this.state = resolveFactArbitration(this.state, { id, result, at: this.now() })
    await this.save()
    const text = `Arbitration ${id} resolved: ${result}`
    const posted = await this.deps.post({
      author: "System",
      authorRole: "system",
      kind: "verdict",
      text,
      runID: this.state.id,
    })
    await this.fanout({
      id: posted.id,
      author: "System",
      authorRole: "system",
      kind: "verdict",
      text,
      to: "all",
      mentions: this.state.members.map((member) => member.label),
      at: this.now(),
    })
    return text
  }

  board(): FieldBoard {
    return boardOf(this.state, this.now())
  }
}

export function boardOf(state: FieldState, now: number): FieldBoard {
  const openMentions = (state.mentions ?? []).filter(
    (mention) => mention.status === "open" && mention.replyBy > now,
  ).length
  const board: FieldBoard = {
    runID: state.id,
    status: state.status,
    objective: state.contract.objective,
    members: state.members.map((member) => {
      const closed =
        state.status === "done" && !["left", "stopped", "failed"].includes(member.status)
      const item: FieldBoard["members"][number] = {
        label: member.label,
        agent: member.agent,
        // A left agent is gone; a field close does not overwrite that history.
        status: closed ? "done" : member.status,
        turns: member.turns,
        maxTurns: member.maxTurns,
      }
      if (member.workstream) item.lane = member.workstream.name
      if (member.leftAt) item.leftAt = member.leftAt
      if (member.leftBy) item.leftBy = member.leftBy
      const waiting = openMentionFrom(state, member.label, now)
      if (waiting) item.waitingFor = waiting.to
      return item
    }),
    posts: state.posts,
    deadEnds: state.deadEnds,
    claims: state.claims.length,
    elapsedMs: Math.max(0, now - state.startedAt),
    budgetMs: state.deadlineAt > 0 ? Math.max(0, state.deadlineAt - state.startedAt) : 0,
  }
  const ledger = state.deliveries ?? []
  if (ledger.length > 0) {
    const delivered = ledger.filter((entry) => entry.deliveredAt !== undefined)
    const latencies = delivered
      .map((entry) => Math.max(0, (entry.deliveredAt as number) - entry.sentAt))
      .sort((left, right) => left - right)
    const percentile = (fraction: number): number | undefined => {
      if (latencies.length === 0) return undefined
      return latencies[Math.min(latencies.length - 1, Math.floor(fraction * (latencies.length - 1)))]
    }
    board.delivery = {
      queued: ledger.length,
      delivered: delivered.length,
      pending: ledger.length - delivered.length,
      truncated: ledger.filter((entry) => entry.truncated).length,
      ...(percentile(0.5) !== undefined ? { p50Ms: percentile(0.5) } : {}),
      ...(percentile(0.9) !== undefined ? { p90Ms: percentile(0.9) } : {}),
    }
  }
  if (openMentions > 0) board.openMentions = openMentions
  if (state.coordination) board.coordination = state.coordination
  if (state.crewReason) board.crewReason = state.crewReason
  const lanes = state.members.filter((member) => member.workstream)
  if (lanes.length > 0) {
    board.workstreams = lanes.map((member) => ({
      name: member.workstream?.name ?? "",
      owner: member.label,
      state: member.status,
    }))
  }
  const facts = state.facts ?? []
  if (facts.length > 0) {
    board.facts = {
      verified: facts.filter(
        (fact) =>
          fact.status === "observed" ||
          fact.status === "verified" ||
          (fact.status === "proposed" && fact.evidence.length > 0),
      ).length,
      contested: facts.filter((fact) => fact.status === "contested").length,
      stale: facts.filter((fact) => fact.status === "superseded").length,
    }
  }
  if (state.oracle) board.oracle = state.oracle
  if (state.phase) board.phase = state.phase
  if ((state.experiments ?? []).length > 0) {
    board.experiments = (state.experiments ?? []).map((experiment) => ({
      id: experiment.id,
      owner: experiment.owner,
      status: experiment.status,
      hypothesis: experiment.hypothesis,
      startedAt: experiment.startedAt,
    }))
  }
  if (state.prior) board.prior = { runID: state.prior.runID, facts: state.prior.facts }
  if (state.report) board.report = state.report
  if (state.foremanSessionID) {
    const maxChecks = state.maxForemanTurns ?? 0
    const checks = state.foremanTurns ?? 0
    const capped = maxChecks > 0 && checks >= maxChecks
    const watching = state.status === "running" && !capped
    const referee: NonNullable<FieldBoard["referee"]> = {
      name: FOREMAN_NAME,
      status: watching ? "watching" : "done",
      checks,
      maxChecks,
    }
    if (watching) referee.nextCheckAt = (state.lastCheckAt || state.startedAt) + state.checkEveryMs
    if (state.lastRefereeDecision) referee.lastDecision = state.lastRefereeDecision
    board.referee = referee
  }
  // The RPC validator rejects `undefined` inside an object, so optional keys
  // are added only when they have a value.
  if (state.stopReason) board.stopReason = state.stopReason
  if (state.closed) board.closed = { decision: state.closed.decision, reason: state.closed.reason }
  return board
}

function kindLimit(kind: FieldPostKind): number {
  // Structured evidence is the deliverable. The old 1,200-char limit rejected
  // exactly the PII dumps, command output and multi-row proofs the room needs.
  if (kind === "claim") return 64_000
  if (kind === "fact" || kind === "finding" || kind === "dead-end" || kind === "test" || kind === "result" || kind === "oracle") {
    return 64_000
  }
  if (kind === "request") return 16_000
  if (kind === "status") return 1_000
  if (kind === "intent" || kind === "handoff") return 8_000
  return 8_000
}

export function openFieldState(input: Parameters<typeof openField>[0]): FieldState {
  return openField(input)
}

export type { FieldMember, FieldState }
