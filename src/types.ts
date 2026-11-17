export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface Usage {
  costUSD: number
  tokens: number
}

export interface ProblemContract {
  objective: string
  constraints: string[]
  successCriteria: string[]
  verificationCommand?: string
  metricRegex?: string
  nonGoals: string[]
  context?: string
}

export type CoordinationMode = "split" | "race" | "hybrid" | "independent"

export type WorkstreamKind = "recon" | "implement" | "verify" | "attack" | "integrate"

/** One independent lane in the field. `owns` is advisory for race lanes and enforced for split lanes. */
export interface Workstream {
  id: string
  name: string
  kind: WorkstreamKind
  owns: string[]
  firstTest: string
  doneWhen: string
}

export interface BriefHypothesis {
  id: string
  statement: string
  test: string
  killIf: string
  timeBoxMinutes: number
}

export type OracleKind = "ui" | "file" | "http" | "process" | "registry" | "command"

/** The observation that decides whether the goal is met. */
export interface Oracle {
  observable: string
  baseline: string
  kind: OracleKind
  /** True once recon has captured the baseline and named the pass condition. */
  confirmed?: boolean
  source?: string
  /** When this field captured the baseline, not when an older run did. */
  capturedAt?: number
  /** Timestamp carried by the observation itself, if it has one. */
  baselineAt?: number
  /** The process/file/path the observation belongs to. A global log is not enough. */
  scope?: string
  /** PID or writer identity that produced the observation. */
  writer?: string
}

export interface BriefAnalysis {
  shape: "fix" | "build" | "research" | "audit" | "migrate" | "batch"
  coordination: CoordinationMode
  workstreams: Workstream[]
  hypotheses: BriefHypothesis[]
  oracle: Oracle
  doneWhen: string[]
  negativeWhen: string[]
  recommendedAgents: number
  recommendedRoles: string[]
  confidence: "low" | "medium" | "high"
  reasons: string[]
}

export type FactStatus = "observed" | "proposed" | "assumed" | "verified" | "refuted" | "contested" | "superseded"

export interface Fact {
  id: string
  seq?: number
  author: string
  claim: string
  evidence: string[]
  area?: string
  status: FactStatus
  basedOn: string[]
  supersedes?: string
  contradicts?: string[]
  at: number
}

export interface HypothesisRecord {
  id: string
  statement: string
  test: string
  killIf: string
  status: "open" | "testing" | "supported" | "refuted" | "stale"
  owner?: string
  timeBoxAt?: number
}

export interface Arbitration {
  id: string
  factIDs: string[]
  test: string
  owner: string
  deadlineAt: number
  status: "open" | "resolved"
  result?: string
}

export type ExperimentStatus = "queued" | "running" | "pass" | "fail" | "invalid" | "cancelled"

/**
 * One bounded experiment. The preflight and the observed process identity are
 * part of the record, not a convention: a reused PID makes the result invalid.
 */
export interface Experiment {
  id: string
  owner: string
  lane?: string
  hypothesis: string
  command: string
  expect: string
  killIf: string
  preflight?: string
  status: ExperimentStatus
  /** The pre-state: PID set, file hash, or registry values before the run. */
  baseline?: string
  /** The post-state: PID set, hash, or raw output after the run. */
  observed?: string
  result?: string
  evidence: string[]
  startedAt?: number
  endedAt?: number
}

export interface FieldReport {
  outcome: "accepted" | "negative" | "inconclusive"
  proven: string[]
  unproven: string[]
  artifacts: string[]
  nextRoutes: string[]
  reason: string
  /** Facts supported by a command or raw output, even if not formally verified. */
  observed?: string[]
  /** Routes that were actually refuted, with the author that closed them. */
  refuted?: string[]
}

/** A file or image attached by the User in the Arena composer. */
export interface Attachment {
  name: string
  mime: string
  /** Base64 without the data: prefix. */
  data: string
}

export interface Stance {
  id: string
  name: string
  objective: string
  cooperation: string
}

export type RoomKind =
  | "chat"
  | "finding"
  | "fact"
  | "hypothesis"
  | "probe"
  | "oracle"
  | "test"
  | "result"
  | "question"
  | "answer"
  | "request"
  | "dead-end"
  | "claim"
  | "intent"
  | "handoff"
  | "lesson"
  | "goal"
  | "system"
  | "lifecycle"
  | "directive"
  | "order"
  | "verdict"

export type RoomRole = "user" | "agent" | "orchestrator" | "system"

export type RoomDelivery = "steer" | "queue" | "digest" | "ignore"

export interface RoomMessage {
  id: string
  roomID: string
  runID?: string
  author: string
  authorRole: RoomRole
  label?: string
  kind: RoomKind
  text: string
  to: string[] | "all"
  mentions: string[]
  replyTo?: string
  private: boolean
  order: boolean
  round: number
  at: number
  meta?: {
    goal?: boolean
    sessionID?: string
    evidence?: string[]
    color?: string
    /** Full text when the visible message is a one-line headline. */
    detail?: string
    attachments?: Attachment[]
  }
}

export interface RoomParticipant {
  label: string
  name: string
  role: RoomRole
  agent?: string
  stance?: string
  model?: string
  sessionID?: string
  runID?: string
  status: "joining" | "idle" | "working" | "left" | "done" | "blocked" | "stopped" | "failed"
  typing?: boolean
  typingAt?: number
  color: string
  keep: string[]
  drop: string[]
  lastSeen: number
}

export interface RoomGoal {
  text: string
  by: string
  status: "proposed" | "accepted" | "stopped"
  at: number
  evidence?: string[]
}

export interface RoomSnapshot {
  id: string
  parentSessionID: string
  title: string
  messages: RoomMessage[]
  participants: RoomParticipant[]
  activeRunID?: string
  goal?: RoomGoal
  closed?: boolean
  createdAt: number
  updatedAt: number
}

/** The panel and the tools read one compact board per field run. */
export interface FieldBoard {
  runID: string
  status: string
  stopReason?: string
  objective: string
  members: {
    label: string
    agent: string
    status: string
    /** Kept for old clients; this is a message count, not a budget. */
    turns: number
    maxTurns: number
    waitingFor?: string
    lane?: string
    leftAt?: number
    leftBy?: string
  }[]
  posts: number
  deadEnds: number
  claims: number
  /** Post-to-seat delivery health, newest ledger window. */
  delivery?: {
    queued: number
    delivered: number
    pending: number
    p50Ms?: number
    p90Ms?: number
    truncated: number
  }
  openMentions?: number
  /** Legacy step-based flag; the continuous driver never sets it. */
  awaitingCoordinator?: boolean
  referee?: {
    name: string
    status: "watching" | "done"
    checks: number
    /** 0 means the referee keeps checking until the field closes. */
    maxChecks: number
    nextCheckAt?: number
    lastDecision?: string
  }
  elapsedMs: number
  budgetMs: number
  closed?: { decision: string; reason: string }
  roomUpdatedAt?: number
  messageCount?: number
  coordination?: CoordinationMode
  crewReason?: string
  workstreams?: { name: string; owner: string; state: string }[]
  facts?: { verified: number; contested: number; stale: number }
  modelSteps?: number
  report?: FieldReport
  oracle?: Oracle
  phase?: "run" | "decide"
  experiments?: {
    id: string
    owner: string
    status: string
    hypothesis: string
    startedAt?: number
  }[]
  prior?: { runID: string; facts: number }
}

export interface VerificationResult {
  label: string
  command?: string
  cwd?: string
  exitCode: number
  output: string
  durationMs: number
  passed: boolean
  metric?: number
  skipped?: string
}

/** A seat in the field: a real name, a role, and a personality written for this task. */
export interface CrewSpec {
  name: string
  role?: string
  brief: string
  /** OpenCode agent id for this seat, for example "build" or "uncensored". */
  agent?: string
}

export interface CrewSeat {
  name: string
  role: string
  brief: string
  agent: string
  model?: ModelRef
  workstream?: Workstream
}

export interface ArenaPlan {
  contestants: number
  agents: string[]
  models: ModelRef[]
  crew: CrewSeat[]
  foremanAgent: string
  foremanModel?: ModelRef
  sameRole?: string
  sameRoleInferred?: boolean
  workspaceMode?: "shared" | "copy"
  maxDurationMinutes: number
  maxTurns: number
  checkEveryMs: number
  flushDelayMs: number
  contestantTimeoutMs: number
  verifyTimeoutMs: number
  foremanTimeoutMs: number
  mentionTimeoutMs: number
  intentLeaseMs: number
  maxForemanTurns: number
  allowNetwork: boolean
  reason: string
  coordination?: CoordinationMode
  crewReason?: string
  toolPolicy?: "arena" | "all"
  scoutMs?: number
  maxCoordinatorOrders?: number
  maxExperiments?: number
  decideMinutes?: number
  coordinatorMinIntervalMs?: number
  coordinatorMaxChars?: number
  maxNoProgressMinutes?: number
  oracle?: Oracle
}

export interface ArenaConfig {
  maxAgents: number
  hardMaxAgents: number
  maxDurationMinutes: number
  maxTurns: number
  checkEveryMinutes: number
  maxForemanTurns: number
  flushDelayMs: number
  contestantTimeoutMs: number
  verifyTimeoutMs: number
  foremanTimeoutMs: number
  mentionTimeoutMs: number
  intentLeaseMs: number
  allowNetwork: boolean
  toolPolicy: "arena" | "all"
  scoutMs: number
  maxCoordinatorOrders: number
  maxExperiments: number
  decideMinutes: number
  coordinatorMinIntervalMs: number
  coordinatorMaxChars: number
  maxNoProgressMinutes: number
}

export const STANCES: Stance[] = [
  {
    id: "builder",
    name: "Builder",
    objective:
      "Ship the smallest change that fully solves the problem. Prefer working code over elegant theory, and verify it by running the thing.",
    cooperation:
      "Post your patch and the exact command that proves it. Ask for a review when you are close, and offer to review a rival's patch when you see a gap.",
  },
  {
    id: "analyst",
    name: "Analyst",
    objective:
      "Map the system before changing it. Find the invariant that is broken, the caller that depends on it, and the smallest intervention that restores it.",
    cooperation:
      "Publish the call graph and the failure path early. A map that saves another agent an hour is worth more than a fast guess.",
  },
  {
    id: "adversary",
    name: "Adversary",
    objective:
      "Break every claim. Attack boundaries, concurrency, retries, hostile input and partial failure. A solution is only as good as its worst case.",
    cooperation:
      "Attack the claim, not the author. Post a reproducing command with every attack, and withdraw it when the evidence disproves it.",
  },
  {
    id: "empiricist",
    name: "Empiricist",
    objective:
      "Measure, do not opine. Reproduce the failure, change one variable, and keep the experiment that actually moves the result.",
    cooperation:
      "Post raw command output, including the runs that failed. Negative results are useful; silently dropping them is not.",
  },
  {
    id: "architect",
    name: "Architect",
    objective:
      "Look for the structural fix. Weigh the change against callers, invariants, migration risk and operational cost. Prefer solutions that fail loudly and recover cheaply.",
    cooperation:
      "Publish the tradeoff table. If a rival's design is better on a dimension you did not consider, say so and merge it.",
  },
  {
    id: "wildcard",
    name: "Wildcard",
    objective:
      "Question the frame. Assume the stated problem hides a different one, and look for a formulation that makes the original problem cheap or irrelevant.",
    cooperation:
      "Propose the strange idea with a cheap test. If it fails, say what it ruled out; a ruled-out frame is progress for the whole team.",
  },
]

export const DEFAULT_CONFIG: ArenaConfig = {
  // No practical ceiling below the task's needs: 50+ concurrent lanes are valid
  // for aggressive, independent attack surfaces. The runner shards above 100.
  maxAgents: 100,
  hardMaxAgents: 100,
  // A field is continuous until the User stops it or every agent leaves. 0 means
  // no deadline and no per-agent wake-up cap.
  maxDurationMinutes: 0,
  maxTurns: 0,
  checkEveryMinutes: 2,
  // Vera is a standing referee, not a four-shot reviewer. 0 means no cap.
  maxForemanTurns: 0,
  flushDelayMs: 1_200,
  // A worker turn may run as long as the work does. The old 10-minute interrupt
  // cut every long investigation in the middle and left its background jobs alive.
  contestantTimeoutMs: 0,
  verifyTimeoutMs: 600_000,
  foremanTimeoutMs: 600_000,
  mentionTimeoutMs: 60_000,
  // Long static analysis needs a lease that survives it. The driver also renews
  // a working owner's lease automatically.
  intentLeaseMs: 600_000,
  allowNetwork: true,
  // "all" keeps the Arena tools available but also exposes host, MCP, skill,
  // browser and subagent tools. Set "arena" for the strict field allowlist.
  toolPolicy: "all",
  scoutMs: 90_000,
  maxCoordinatorOrders: 16,
  // Continuous rooms do not have a global experiment quota. A per-seat test
  // still needs its own result, and two tests on the same resource serialize.
  maxExperiments: 0,
  // Kept for old plan payloads; the continuous field no longer has a decide phase.
  decideMinutes: 0,
  // A live room moves faster than one decision per minute. Thirty seconds is
  // enough to stop spam without making an urgent steer wait a full minute.
  coordinatorMinIntervalMs: 30_000,
  // 320 was too tight for one path plus one expected output; the session spent
  // turns trimming and still hit "too long by 11 chars".
  coordinatorMaxChars: 600,
  maxNoProgressMinutes: 20,
}
