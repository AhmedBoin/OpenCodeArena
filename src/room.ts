import type {
  RoomDelivery,
  RoomGoal,
  RoomKind,
  RoomMessage,
  RoomParticipant,
  RoomRole,
  RoomSnapshot,
} from "./types.ts"

const USER_LABEL = "User"
const ORCHESTRATOR_LABEL = "Orchestrator"

export const ROOM_LABELS = {
  user: USER_LABEL,
  orchestrator: ORCHESTRATOR_LABEL,
}

export function colorFor(label: string): string {
  if (label === USER_LABEL) return "#2563eb"
  if (label === ORCHESTRATOR_LABEL) return "#7c3aed"
  let hash = 0
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return `hsl(${hue} 62% 44%)`
}

function normalize(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed
  if (trimmed.toLowerCase() === "user" || trimmed.toLowerCase() === "you") return USER_LABEL
  if (trimmed.toLowerCase() === "orchestrator") return ORCHESTRATOR_LABEL
  if (trimmed.toLowerCase() === "all") return "all"
  return trimmed.toUpperCase().startsWith("C") ? trimmed.toUpperCase() : trimmed
}

function mentionsOf(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/@([A-Za-z][A-Za-z0-9_-]*)/g)) {
    const label = normalize(match[1] as string)
    if (label.length > 0 && !found.includes(label)) found.push(label)
  }
  return found
}

function includesLabel(to: string[] | "all", label: string): boolean {
  return to === "all" || to.includes("all") || to.includes(label)
}

export interface RoomPostInput {
  author: string
  authorRole: RoomRole
  kind: RoomKind
  text: string
  to?: string[] | "all" | string
  mentions?: string[]
  replyTo?: string
  private?: boolean
  order?: boolean
  runID?: string
  round?: number
  meta?: RoomMessage["meta"]
}

export class ArenaRoom {
  readonly id: string
  readonly parentSessionID: string
  private messages: RoomMessage[] = []
  private participants = new Map<string, RoomParticipant>()
  private counter = 0
  private title = "Arena room"
  private activeRunID: string | undefined
  private goal: RoomGoal | undefined
  private closed = false
  private readonly createdAt: number
  private updatedAt: number

  constructor(parentSessionID: string, snapshot?: RoomSnapshot) {
    this.parentSessionID = parentSessionID
    this.id = `room:${parentSessionID}`
    this.createdAt = snapshot?.createdAt ?? Date.now()
    this.updatedAt = snapshot?.updatedAt ?? this.createdAt
    if (snapshot) {
      this.title = snapshot.title
      this.activeRunID = snapshot.activeRunID
      this.goal = snapshot.goal
      this.closed = snapshot.closed === true
      this.messages = [...snapshot.messages]
      for (const participant of snapshot.participants) this.participants.set(participant.label, { ...participant })
      this.counter = this.messages.reduce((max, message) => {
        const value = Number(message.id.replace(/^m/, ""))
        return Number.isFinite(value) ? Math.max(max, value) : max
      }, 0)
    }
    this.ensureCore()
  }

  static from(snapshot: RoomSnapshot): ArenaRoom {
    return new ArenaRoom(snapshot.parentSessionID, snapshot)
  }

  private ensureCore(): void {
    this.addParticipant({ label: USER_LABEL, name: "You", role: "user", status: "idle" })
    this.addParticipant({ label: ORCHESTRATOR_LABEL, name: "Orchestrator", role: "orchestrator", status: "idle" })
  }

  addParticipant(input: {
    label: string
    name?: string
    role?: RoomRole
    agent?: string
    stance?: string
    model?: string
    sessionID?: string
    runID?: string
    status?: RoomParticipant["status"]
  }): RoomParticipant {
    const label = normalize(input.label)
    const existing = this.participants.get(label)
    if (existing) {
      if (input.name) existing.name = input.name
      if (input.role) existing.role = input.role
      if (input.agent) existing.agent = input.agent
      if (input.stance) existing.stance = input.stance
      if (input.model) existing.model = input.model
      if (input.sessionID) existing.sessionID = input.sessionID
      if (input.runID) existing.runID = input.runID
      if (input.status) existing.status = input.status
      existing.lastSeen = Date.now()
      this.touch()
      return existing
    }
    const participant: RoomParticipant = {
      label,
      name: input.name ?? label,
      role: input.role ?? (label === USER_LABEL ? "user" : label === ORCHESTRATOR_LABEL ? "orchestrator" : "agent"),
      agent: input.agent,
      stance: input.stance,
      model: input.model,
      sessionID: input.sessionID,
      runID: input.runID,
      status: input.status ?? "joining",
      color: colorFor(label),
      keep: [],
      drop: [],
      lastSeen: Date.now(),
    }
    this.participants.set(label, participant)
    this.touch()
    return participant
  }

  bind(label: string, sessionID: string, runID?: string): RoomParticipant | undefined {
    const participant = this.participants.get(normalize(label))
    if (!participant) return undefined
    participant.sessionID = sessionID
    if (runID) participant.runID = runID
    participant.status = "idle"
    participant.typing = false
    participant.typingAt = undefined
    participant.lastSeen = Date.now()
    this.touch()
    return participant
  }

  setTyping(label: string, typing: boolean): void {
    const participant = this.participants.get(normalize(label))
    if (!participant) return
    if (participant.typing === typing) return
    participant.typing = typing
    participant.typingAt = typing ? Date.now() : undefined
    participant.lastSeen = Date.now()
    if (typing && participant.status !== "done" && participant.status !== "stopped" && participant.status !== "failed") {
      participant.status = "working"
    }
    this.touch()
  }

  clearTyping(): void {
    let changed = false
    for (const participant of this.participants.values()) {
      if (!participant.typing) continue
      participant.typing = false
      participant.typingAt = undefined
      changed = true
    }
    if (changed) this.touch()
  }

  /** Drop live sessions from an earlier run so a new run cannot deliver into them. */
  detachOtherRuns(runID: string): void {
    for (const participant of this.participants.values()) {
      if (participant.role !== "agent") continue
      if (participant.runID === runID) continue
      participant.sessionID = undefined
      participant.status = "idle"
      participant.typing = false
      participant.typingAt = undefined
    }
    this.touch()
  }

  setStatus(label: string, status: RoomParticipant["status"]): void {
    const participant = this.participants.get(normalize(label))
    if (!participant) return
    participant.status = status
    if (status !== "working") {
      participant.typing = false
      participant.typingAt = undefined
    }
    participant.lastSeen = Date.now()
    this.touch()
  }

  setActiveRun(runID: string | undefined): void {
    this.activeRunID = runID
    this.touch()
  }

  close(): void {
    this.closed = true
    this.touch()
  }

  reopen(): void {
    this.closed = false
    this.touch()
  }

  isClosed(): boolean {
    return this.closed
  }

  setTitle(title: string): void {
    this.title = title
    this.touch()
  }

  setGoal(goal: RoomGoal | undefined): void {
    this.goal = goal
    this.touch()
  }

  post(input: RoomPostInput): RoomMessage {
    const explicit = Array.isArray(input.to) ? input.to.map(normalize) : input.to ? [normalize(input.to)] : ["all"]
    const to: string[] | "all" = explicit.includes("all") ? "all" : explicit
    const mentions = [...new Set([...(input.mentions ?? []).map(normalize), ...mentionsOf(input.text)])]
    const message: RoomMessage = {
      id: this.nextID(),
      roomID: this.id,
      runID: input.runID ?? this.activeRunID,
      author: normalize(input.author),
      authorRole: input.authorRole,
      label: input.authorRole === "agent" ? normalize(input.author) : undefined,
      kind: input.kind,
      text: input.text.trim(),
      to,
      mentions,
      replyTo: input.replyTo,
      private: input.private === true,
      order: input.order === true,
      round: input.round ?? 1,
      at: Date.now(),
      meta: input.meta,
    }
    this.messages.push(message)
    if (this.messages.length > 2000) this.messages.splice(0, this.messages.length - 2000)
    if (message.kind === "goal") {
      this.goal = {
        text: message.text,
        by: message.author,
        status: "proposed",
        at: message.at,
        evidence: message.meta?.evidence,
      }
    }
    const author = this.participants.get(message.author)
    if (author?.role === "agent") {
      author.typing = false
      author.typingAt = undefined
      author.lastSeen = message.at
    }
    this.touch()
    return message
  }

  all(): readonly RoomMessage[] {
    return this.messages
  }

  participant(label: string): RoomParticipant | undefined {
    return this.participants.get(normalize(label))
  }

  participantBySession(sessionID: string): RoomParticipant | undefined {
    for (const participant of this.participants.values()) {
      if (participant.sessionID === sessionID) return participant
    }
    return undefined
  }

  list(): readonly RoomParticipant[] {
    return [...this.participants.values()]
  }

  read(label: string, after?: string): RoomMessage[] {
    const participant = this.participants.get(normalize(label))
    const start = after ? Math.max(0, this.messages.findIndex((message) => message.id === after) + 1) : 0
    return this.messages.slice(start).filter((message) => {
      if (message.author === participant?.label) return true
      if (message.private) return includesLabel(message.to, normalize(label)) || participant?.role === "orchestrator"
      return includesLabel(message.to, normalize(label)) || message.to === "all"
    })
  }

  route(message: RoomMessage, participant: RoomParticipant): RoomDelivery {
    if (message.author === participant.label) return "ignore"
    if (participant.role === "user") return "ignore"
    const label = participant.label
    if (message.private) {
      if (includesLabel(message.to, label)) return "steer"
      return participant.role === "orchestrator" ? "digest" : "ignore"
    }
    if (message.authorRole === "user" || message.authorRole === "orchestrator") return "steer"
    if (message.order || message.kind === "order" || message.kind === "directive") return "steer"
    if (message.kind === "goal") return "steer"
    if (participant.drop.includes(message.id) && !participant.keep.includes(message.id)) return "ignore"
    if (message.mentions.includes(label) || message.mentions.includes("all")) {
      return "steer"
    }
    if (message.kind === "system" || message.kind === "lifecycle") {
      return participant.role === "orchestrator" ? "digest" : "ignore"
    }
    if (message.kind === "question" || message.kind === "answer") {
      return includesLabel(message.to, label) || message.to === "all" ? "queue" : "ignore"
    }
    // Field facts: a peer learns them at its next safe point, never mid-turn.
    if (
      message.kind === "request" ||
      message.kind === "dead-end" ||
      message.kind === "claim" ||
      message.kind === "finding" ||
      message.kind === "intent" ||
      message.kind === "handoff" ||
      message.kind === "lesson"
    ) {
      return includesLabel(message.to, label) || message.to === "all" ? "queue" : "ignore"
    }
    if (message.kind === "chat") {
      return includesLabel(message.to, label) ? "queue" : "ignore"
    }
    if (message.kind === "verdict") return "digest"
    return "ignore"
  }

  consume(label: string, ids: string[], keep: boolean): string[] {
    const participant = this.participants.get(normalize(label))
    if (!participant) return []
    const touched: string[] = []
    for (const id of ids) {
      if (!/^m\d+$/.test(id)) continue
      if (keep) {
        if (!participant.keep.includes(id)) participant.keep.push(id)
        participant.drop = participant.drop.filter((value) => value !== id)
      } else {
        if (!participant.drop.includes(id)) participant.drop.push(id)
        participant.keep = participant.keep.filter((value) => value !== id)
      }
      touched.push(id)
    }
    participant.lastSeen = Date.now()
    this.touch()
    return touched
  }

  digest(label: string, limitChars = 2600): string {
    const participant = this.participants.get(normalize(label))
    if (!participant) return ""
    const lines: string[] = []
    let used = 0
    for (const message of [...this.messages].reverse()) {
      if (message.author === participant.label) continue
      if (participant.drop.includes(message.id) && !participant.keep.includes(message.id)) continue
      if (message.private && !includesLabel(message.to, participant.label) && participant.role !== "orchestrator") continue
      if (message.kind === "chat" && !includesLabel(message.to, participant.label) && !message.mentions.includes(participant.label)) continue
      const prefix = message.order || message.authorRole === "user" ? "ORDER " : ""
      const line = `[${message.id}] ${prefix}${message.author} (${message.kind}): ${message.text.replace(/\s+/g, " ").slice(0, 420)}`
      if (used + line.length > limitChars) break
      lines.unshift(line)
      used += line.length + 1
    }
    return lines.length > 0 ? lines.join("\n") : "No relevant room messages."
  }

  contextBlock(label: string): string {
    const participant = this.participants.get(normalize(label))
    if (!participant) return ""
    const messages = this.messages.filter((message) => {
      if (message.author === participant.label) return false
      if (participant.drop.includes(message.id) && !participant.keep.includes(message.id)) return false
      if (message.private && !includesLabel(message.to, participant.label) && participant.role !== "orchestrator") return false
      if (message.kind === "chat" && !includesLabel(message.to, participant.label) && !message.mentions.includes(participant.label)) return false
      return true
    })
    if (messages.length === 0) return ""
    return messages
      .slice(-6)
      .map((message) => {
        const prefix = message.order || message.authorRole === "user" ? "ORDER " : ""
        return `[${message.id}] ${prefix}${message.author}: ${message.text.replace(/\s+/g, " ").slice(0, 220)}`
      })
      .join("\n")
  }

  /**
   * Merge another snapshot of this room into this instance. Messages are unioned
   * by id, so two in-memory copies can never silently drop each other's writes.
   * A newer instance (by updatedAt) stays authoritative for state, so a reopen,
   * a stop or a cleared typing flag is not undone by an older snapshot.
   */
  private nextID(): string {
    let id = `m${this.counter + 1}`
    while (this.messages.some((message) => message.id === id)) {
      this.counter += 1
      id = `m${this.counter + 1}`
    }
    this.counter += 1
    return id
  }

  absorb(snapshot: RoomSnapshot): void {
    const byId = new Map<string, RoomMessage>()
    let next = this.counter
    for (const message of this.messages) byId.set(message.id, message)
    for (const message of snapshot.messages) {
      const existing = byId.get(message.id)
      // Two instances can allocate the same id. Keep both rather than letting
      // one vanish: the newcomer gets a fresh id above the current maximum.
      if (existing && (existing.author !== message.author || existing.text !== message.text)) {
        next += 1
        byId.set(`m${next}`, { ...message, id: `m${next}` })
        continue
      }
      byId.set(message.id, message)
    }
    this.messages = [...byId.values()].sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))
    this.counter = this.messages.reduce((max, message) => {
      const value = Number(message.id.slice(1))
      return Number.isFinite(value) ? Math.max(max, value) : max
    }, Math.max(this.counter, next))

    const fresher = snapshot.updatedAt > this.updatedAt
    for (const participant of snapshot.participants) {
      const existing = this.participants.get(participant.label)
      if (!existing) {
        this.participants.set(participant.label, { ...participant })
        continue
      }
      if (!fresher) continue
      existing.sessionID = participant.sessionID ?? existing.sessionID
      existing.runID = participant.runID ?? existing.runID
      existing.agent = participant.agent ?? existing.agent
      existing.typing = participant.typing === true
      existing.typingAt = participant.typingAt
      existing.status = participant.status
      existing.keep = [...participant.keep]
      existing.drop = [...participant.drop]
    }

    if (fresher) {
      this.closed = snapshot.closed === true
      this.activeRunID = snapshot.activeRunID
      this.goal = snapshot.goal
      this.title = snapshot.title
    }
    if (snapshot.updatedAt > this.updatedAt) this.updatedAt = snapshot.updatedAt
    this.ensureCore()
    this.touch()
  }

  toJSON(): RoomSnapshot {
    return {
      id: this.id,
      parentSessionID: this.parentSessionID,
      title: this.title,
      messages: [...this.messages],
      participants: [...this.participants.values()],
      activeRunID: this.activeRunID,
      goal: this.goal,
      closed: this.closed,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  private touch(): void {
    this.updatedAt = Date.now()
  }
}
