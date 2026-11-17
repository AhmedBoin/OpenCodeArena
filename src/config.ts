import { modelRefs } from "./model.ts"
import { analyzeBrief, isSerializedTarget, suggestSameRole } from "./core/brief.ts"
import { makeCrew, normalizeCrew } from "./field/roster.ts"
import {
  DEFAULT_CONFIG,
  type ArenaConfig,
  type ArenaPlan,
  type BriefAnalysis,
  type CrewSeat,
  type CrewSpec,
  type ModelRef,
  type ProblemContract,
} from "./types.ts"

export interface ArenaOptions {
  contestants?: number
  crew?: CrewSpec[]
  agentType?: string
  sameRole?: string
  workspaceMode?: "shared" | "copy"
  agents?: string[]
  models?: string[]
  foremanAgent?: string
  foremanModel?: string
  network?: boolean
  /** "arena" keeps the strict allowlist; "all" exposes host, MCP, browser and subagent tools. */
  toolPolicy?: "arena" | "all"
  maxDurationMinutes?: number
  maxTurns?: number
  maxSteps?: number
  checkEveryMinutes?: number
  mentionTimeoutSeconds?: number
  leaseMinutes?: number
}

export interface PlanInput {
  contract: ProblemContract
  options: ArenaOptions
  parentAgent: string
  availableAgents: string[]
  analysis?: BriefAnalysis
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function complexityScore(contract: ProblemContract): number {
  let score = 0
  if (contract.objective.length > 160) score++
  if (contract.objective.length > 400) score++
  score += Math.min(2, Math.floor(contract.constraints.length / 2))
  score += Math.min(2, Math.floor(contract.successCriteria.length / 2))
  if (/(architect|migrat|refactor|distributed|concurr|performance|optimi|security|race|protocol)/i.test(`${contract.objective} ${contract.context ?? ""}`)) {
    score++
  }
  if (contract.verificationCommand) score++
  return score
}

export function chooseContestants(contract: ProblemContract, config: ArenaConfig): number {
  const recommended = analyzeBrief(contract).recommendedAgents
  return Math.min(config.hardMaxAgents, Math.max(2, recommended))
}

function pickForeman(input: PlanInput): string {
  if (input.options.foremanAgent && input.options.foremanAgent.length > 0) return input.options.foremanAgent
  if (input.availableAgents.includes("plan")) return "plan"
  if (input.availableAgents.includes("build")) return "build"
  return input.parentAgent
}

export function planRun(input: PlanInput): ArenaPlan {
  const config = resolveConfig(input.options)
  const analysis = input.analysis ?? analyzeBrief(input.contract)
  const authored = normalizeCrew(input.options.crew)
  const explicitRole = input.options.sameRole?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined
  // If the user did not say a role or write a crew, infer whether this is a
  // one-target/unknown-route problem where independent same-role peers beat a
  // divided committee. A multi-deliverable or migration brief stays split.
  const suggestion = authored.length === 0 && !explicitRole ? suggestSameRole(input.contract, analysis) : undefined
  const sameRole = explicitRole ?? suggestion?.role
  const sameRoleInferred = !explicitRole && Boolean(suggestion)
  const serialized = Boolean(sameRole) && isSerializedTarget(input.contract, analysis)
  const requestedCount = input.options.contestants
  const count = clamp(
    authored.length > 0
      ? authored.length
      : (requestedCount ?? (serialized ? Math.min(2, analysis.recommendedAgents) : analysis.recommendedAgents)),
    2,
    2,
    config.hardMaxAgents,
  )
  const seats = authored.length > 0 ? authored.slice(0, count) : makeCrew(count)
  const pool = input.options.agents?.filter((agent) => typeof agent === "string" && agent.length > 0) ?? []
  const agentPool = pool.length > 0 ? pool : [input.parentAgent]
  const sharedAgent = input.options.agentType?.trim() || undefined
  const models = modelRefs(input.options.models)
  // Recon gets the first (fast) model, verification gets the last (deep) one.
  // A single model cycles as before; ordering is the only configuration.
  const modelFor = (index: number, kind: string | undefined) => {
    if (models.length === 0) return undefined
    if (models.length === 1) return models[0]
    if (kind === "recon") return models[0]
    if (kind === "verify" || kind === "integrate") return models[models.length - 1]
    return models[index % models.length]
  }
  const workspaceMode =
    input.options.workspaceMode ?? (sameRole && count <= 8 ? "copy" : "shared")
  const crew: CrewSeat[] = seats.map((seat, index) => ({
    name: seat.name,
    role: sameRole ?? seat.role ?? "Independent",
    brief: seat.brief,
    agent: seat.agent || sharedAgent || (agentPool[index % agentPool.length] as string),
    model: modelFor(index, analysis.workstreams[index % Math.max(1, analysis.workstreams.length)]?.kind),
    // A same-role room is independent by design: every agent owns the whole
    // problem and no lane boundary can tell it to stay out of another's work.
    workstream: sameRole ? undefined : analysis.workstreams[index % Math.max(1, analysis.workstreams.length)],
  }))
  const agentNote = sharedAgent
    ? `all seats run the ${sharedAgent} agent`
    : "seats cycle the requested agent types"
  const foremanAgent = pickForeman(input)
  const foremanModel = input.options.foremanModel
    ? modelRefs([input.options.foremanModel])[0]
    : models.length > 1
      ? models[models.length - 1]
      : undefined
  const authoredNote =
    authored.length > 0 ? "crew and personalities written by the main session" : "fallback crew with random names"
  const reasons = [
    `${crew.length}-person crew (${authoredNote})`,
    agentNote,
    models.length === 0 ? "every agent uses its own default model" : `${models.length} model(s) cycle across the crew`,
    `Referee ${foremanAgent}${foremanModel ? ` (${foremanModel.providerID}/${foremanModel.id})` : ""}`,
    sameRole
      ? `${crew.length} independent ${sameRole} seat(s), same role${
          sameRoleInferred ? ` (inferred: ${suggestion?.reason})` : ""
        }, ${workspaceMode === "copy" ? "copy-on-write" : "shared"} workspace${
          serialized && requestedCount === undefined ? " (two-seat serialized-target default)" : ""
        }`
      : `${analysis.coordination} coordination: ${analysis.workstreams.length} lane(s)`,
    ...analysis.reasons.slice(0, 3),
  ]
  return {
    contestants: crew.length,
    agents: crew.map((seat) => seat.agent),
    models,
    crew,
    foremanAgent,
    foremanModel,
    sameRole,
    sameRoleInferred,
    workspaceMode,
    maxDurationMinutes: config.maxDurationMinutes,
    // Continuous room: no per-agent wake-up budget. maxSteps/maxTurns remain
    // accepted input for old callers but no longer limit anyone.
    maxTurns: 0,
    checkEveryMs: clamp(input.options.checkEveryMinutes, config.checkEveryMinutes, 1, 30) * 60_000,
    flushDelayMs: config.flushDelayMs,
    contestantTimeoutMs: config.contestantTimeoutMs,
    verifyTimeoutMs: config.verifyTimeoutMs,
    foremanTimeoutMs: config.foremanTimeoutMs,
    mentionTimeoutMs: clamp((input.options.mentionTimeoutSeconds ?? 60) * 1_000, config.mentionTimeoutMs, 10_000, 600_000),
    intentLeaseMs: clamp(
      (input.options.leaseMinutes ?? Math.round(config.intentLeaseMs / 60_000)) * 60_000,
      config.intentLeaseMs,
      60_000,
      3_600_000,
    ),
    maxForemanTurns: config.maxForemanTurns,
    allowNetwork: config.allowNetwork,
    toolPolicy: input.options.toolPolicy ?? config.toolPolicy,
    reason: reasons.join("; "),
    // Same-role seats are not lanes. Advertising `split` here made the card and
    // kickoff contradict the same-role rule ("do not wait for a lane
    // assignment") and told peers to stay out of each other's work.
    coordination: sameRole ? "independent" : analysis.coordination,
    crewReason: analysis.reasons.join(" "),
    scoutMs: config.scoutMs,
    maxCoordinatorOrders: config.maxCoordinatorOrders,
    maxExperiments: config.maxExperiments,
    decideMinutes: config.decideMinutes,
    coordinatorMinIntervalMs: config.coordinatorMinIntervalMs,
    coordinatorMaxChars: config.coordinatorMaxChars,
    maxNoProgressMinutes: config.maxNoProgressMinutes,
    oracle: analysis.oracle,
  }
}

export function resolveConfig(options: ArenaOptions = {}): ArenaConfig {
  const envMax = Number(process.env.ARENA_MAX_AGENTS)
  const hardMaxAgents = clamp(
    Number.isFinite(envMax) ? envMax : undefined,
    DEFAULT_CONFIG.hardMaxAgents,
    2,
    500,
  )
  return {
    ...DEFAULT_CONFIG,
    maxAgents: hardMaxAgents,
    hardMaxAgents,
    maxDurationMinutes: clamp(options.maxDurationMinutes, DEFAULT_CONFIG.maxDurationMinutes, 0, 240),
    // Network is always on. A target named in the brief is never refused, and a
    // caller-supplied `network:false` no longer removes fetch/search capability.
    allowNetwork: true,
    toolPolicy: options.toolPolicy ?? DEFAULT_CONFIG.toolPolicy,
  }
}
