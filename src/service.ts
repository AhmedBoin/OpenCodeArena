/**
 * The Arena control plane: rooms, sessions, storage, hooks and one live
 * `FieldRun` per field. Everything host-specific arrives through `ServiceDeps`.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parseRoomCommand } from "./commands.ts"
import { resourceLockKey, withRunLock } from "./core/mutex.ts"

import { planRun, resolveConfig, type ArenaOptions } from "./config.ts"
import { analyzeBrief, suggestSameRole } from "./core/brief.ts"
import { finishField, openField, setSession, type FieldPostKind, type FieldState } from "./core/field.ts"
import { digest, type KnowledgeItem, type KnowledgeKind, type KnowledgeView } from "./core/knowledge.ts"
import { objectiveKey, priorFromReport, seedPrior, type PriorMemory } from "./core/prior.ts"
import { permissionRules, type SessionBinding } from "./bindings.ts"
import { arenaOnlyCode } from "./field/code-mode.ts"
import { FieldRun, boardOf, type FieldDeps } from "./field/run.ts"
import { FOREMAN_NAME } from "./field/roster.ts"
import { fastModel, parseModel } from "./model.ts"
import { killProcessTree } from "./process.ts"
import { refereeRole } from "./field/prompts.ts"
import { helperPrompt } from "./prompts.ts"
import { ArenaRoom, ROOM_LABELS } from "./room.ts"
import { isSealed, sealOf, sealSession } from "./seal.ts"
import { sleep } from "./scheduler.ts"
import { oneLine } from "./text.ts"
import type { ArenaRuntime } from "./runtime.ts"
import type { Workspace, WorkspacePort } from "./workspace.ts"
import type {
  ArenaPlan,
  Attachment,
  CrewSpec,
  FieldBoard,
  ModelRef,
  ProblemContract,
  RoomKind,
  RoomMessage,
  RoomRole,
  RoomSnapshot,
  Usage,
  Workstream,
} from "./types.ts"

export interface ServiceStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<void>
}

export interface ServiceDeps {
  runtime: ArenaRuntime
  workspace: WorkspacePort
  storage: ServiceStorage
  root: string
  synthetic(sessionID: string, text: string): Promise<void>
  parentInfo(sessionID: string): Promise<{ agent?: string; model?: ModelRef }>
}

export interface ArenaPreview {
  plan: ArenaPlan
  agents: { id: string; description?: string; mode?: string }[]
  contract: ProblemContract
}

/**
 * A plugin hot reload creates a new service in the same process. The run was
 * already resumed once, so the new service must adopt it without posting a
 * second "resumed" message or starting every agent's turn again.
 */
function seenRuns(): Set<string> {
  const shared = globalThis as typeof globalThis & { __opencodeArenaSeenRuns?: Set<string> }
  shared.__opencodeArenaSeenRuns ??= new Set()
  return shared.__opencodeArenaSeenRuns
}

export interface ArenaStatus {
  text: string
}

export interface SpawnResult {
  ok: boolean
  text: string
  sessionID?: string
  usage?: Usage
}

export interface RoomChatInput {
  parentSessionID?: string
  runID?: string
  authorRole?: RoomRole
  authorLabel?: string
  authorSessionID?: string
  /** The session that actually invoked chat. A field-bound session can never be User. */
  callerSessionID?: string
  /** True only for the trusted Arena panel RPC, which the User operates. */
  panel?: boolean
  text: string
  to?: string[] | "all"
  order?: boolean
  private?: boolean
  kind?: RoomKind
  replyTo?: string
  meta?: RoomMessage["meta"]
  attachments?: Attachment[]
}

export interface RoomChatResult {
  message: RoomMessage
  delivered: number
  room: RoomSnapshot
  text: string
}

export interface ArenaJobInfo {
  id: string
  runID: string
  label: string
  command: string
  cwd: string
  status: "running" | "exited" | "failed" | "stopped"
  pid?: number
  startedAt: number
  /** Foreground jobs hold the run lock; background jobs do not. */
  foreground?: boolean
  endedAt?: number
  exitCode?: number
  output: string
}

interface ArenaJob extends ArenaJobInfo {
  child?: ChildProcess
}

interface FieldWork {
  binding: { runID: string; label: string }
  run: FieldRun
  cwd: string
  sharedRoot: string
  copyOnWrite: boolean
  workspace?: Workspace
}

function makeID(): string {
  const stamp = Date.now().toString(36)
  const noise = Math.floor(Math.random() * 1_679_616).toString(36)
  return `${stamp}${noise}`
}

function knowledgeKind(kind: RoomKind): KnowledgeKind {
  if (kind === "system") return "status"
  if (kind === "directive") return "order"
  if (kind === "verdict") return "verdict"
  return kind as KnowledgeKind
}

function fieldKindOf(kind: string): FieldPostKind {
  const known = [
    "finding",
    "fact",
    "hypothesis",
    "probe",
    "oracle",
    "test",
    "result",
    "dead-end",
    "request",
    "question",
    "answer",
    "claim",
    "status",
    "note",
    "intent",
    "handoff",
    "lesson",
  ] as const
  return (known as readonly string[]).includes(kind) ? (kind as (typeof known)[number]) : "note"
}

/**
 * Host storage may hand back a string, an object, or a string that was encoded
 * twice by an older wrapper. Decode all three shapes instead of trusting one.
 */
function readStored<T>(raw: unknown): T | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === "object") return raw as T
  if (typeof raw !== "string") return undefined
  try {
    let parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "string") parsed = JSON.parse(parsed)
    return parsed as T
  } catch {
    return undefined
  }
}

export class ArenaService {
  readonly bindings = new Map<string, SessionBinding>()
  readonly fields = new Map<string, FieldRun>()
  private readonly fieldSessions = new Map<string, { runID: string; label: string; parentSessionID: string }>()
  private readonly rooms = new Map<string, ArenaRoom>()
  private readonly roomIDs = new Set<string>()
  private readonly sessionParents = new Map<string, string>()
  private readonly closingParents = new Map<string, number>()
  private roomTimer: ReturnType<typeof setInterval> | undefined
  private roomPolling = false
  private readonly rootCache = new Map<string, string>()
  private readonly jobs = new Map<string, ArenaJob>()
  private readonly fieldWorkspaces = new Map<string, Map<string, Workspace>>()
  private jobSeq = 0

  constructor(private readonly deps: ServiceDeps) {}

  /**
   * The Arena belongs to the root session. A panel opened on a child agent
   * (or any descendant) talks to the same room as its parent instead of
   * creating an empty room for the child.
   */
  private async rootSession(sessionID: string): Promise<string> {
    const cached = this.rootCache.get(sessionID)
    if (cached) return cached
    let current = sessionID
    for (let depth = 0; depth < 6; depth++) {
      const info = await this.deps.runtime.info(current).catch(() => undefined)
      const parent = info?.parentID
      if (!parent || parent === current) break
      current = parent
    }
    this.rootCache.set(sessionID, current)
    return current
  }

  async init(): Promise<void> {
    const roomIndex = await this.deps.storage.get("arena/rooms").catch(() => undefined)
    if (typeof roomIndex === "string") {
      try {
        const ids = readStored<string[]>(roomIndex)
        for (const parentSessionID of ids ?? []) {
          const snapshot = await this.loadRoomSnapshot(parentSessionID)
          if (!snapshot) continue
          const room = ArenaRoom.from(snapshot)
          this.rooms.set(parentSessionID, room)
          this.indexRoom(room)
        }
        if (this.rooms.size > 0) this.ensureRoomTimer()
      } catch {
        // A broken room index must not stop the plugin from loading.
      }
    }
    await this.resumeFields()
  }

  async preview(contract: ProblemContract, options: ArenaOptions, parentSessionID: string): Promise<ArenaPreview> {
    const parent = await this.deps.parentInfo(parentSessionID).catch(() => undefined)
    const agents = await this.deps.runtime.listAgents().catch(() => [])
    const plan = planRun({
      contract,
      options,
      parentAgent: parent?.agent ?? "build",
      availableAgents: agents.map((agent) => agent.id),
    })
    if (plan.models.length === 0 && parent?.model) plan.models = [parent.model]
    if (!plan.foremanModel && parent?.model) plan.foremanModel = fastModel(parent.model)
    this.validateAgents(plan, agents.map((agent) => agent.id), parent?.agent ?? "build")
    return { plan, agents: agents.map((agent) => ({ id: agent.id, description: agent.description, mode: agent.mode })), contract }
  }

  private validateAgents(plan: ArenaPlan, available: string[], parentAgent: string): void {
    if (available.length === 0) return
    const missing = [...new Set([...plan.agents, plan.foremanAgent])].filter(
      (agent) => !available.includes(agent) && agent !== parentAgent,
    )
    if (missing.length > 0) {
      throw new Error(`unknown agent(s): ${missing.join(", ")}. Available: ${available.join(", ")}`)
    }
  }

  /**
   * The `/arena` slash command: the text after the command is the whole brief.
   * No planning model turn, no confirmation question, no prose. The normal
   * planner chooses the crew size and starts the field.
   */
  async startFromCommand(text: string, parentSessionID: string): Promise<string> {
    parentSessionID = await this.rootSession(parentSessionID)
    const command = text.trim()
    let problem = command
      .replace(/^\s*\/arena(?:\s+|$)/i, "")
      .replace(/^\s+/, "")
      .trim()
    // `/arena continue ...` keeps the same crew, sessions and history.
    const continuing = /^continue\b\s*/i.exec(problem)
    if (continuing) {
      let mission = problem.slice(continuing[0].length).trim()
      let requestedMinutes: number | undefined
      const minutesFlag = mission.match(/^--minutes\s+(\d+)\s+/i)
      if (minutesFlag) {
        requestedMinutes = Number(minutesFlag[1])
        mission = mission.slice(minutesFlag[0].length).trim()
      }
      return this.continueFromCommand(mission, parentSessionID, requestedMinutes)
    }
    let requestedAgents: number | undefined
    let requestedMinutes: number | undefined
    let requestedRole: string | undefined
    const flag = /^--(same-role|role|agents|minutes)(?:\s+|$)(?:"([^"]*)"|'([^']*)'|(\S*))/i
    for (;;) {
      const match = flag.exec(problem)
      if (!match) break
      const key = (match[1] ?? "").toLowerCase()
      const value = (match[2] ?? match[3] ?? match[4] ?? "").trim()
      problem = problem.slice(match[0].length).trim()
      if (key === "same-role" || key === "role") requestedRole = value || undefined
      else if (key === "agents") requestedAgents = Number(value)
      else if (key === "minutes") requestedMinutes = Number(value)
    }
    if (problem.length < 8) {
      return "Usage: /arena [--same-role \"Builder\"] [--agents N] [--minutes M] <problem to solve>, or /arena continue [--minutes M] <new mission>."
    }
    const active = await this.activeFieldRun(parentSessionID).catch(() => undefined)
    if (active) {
      return `Arena ${active} is already running for this session. Use /arena continue <new mission> to reuse its agents, or stop it before starting a new crew.`
    }
    try {
      const brief: ProblemContract = {
        objective: problem,
        constraints: [],
        successCriteria: [],
        nonGoals: [],
        context:
          "Started directly by the /arena command. The text after /arena is the whole brief; choose the crew and work it.",
      }
      const analysis = analyzeBrief(brief)
      const roleHint = requestedRole ?? suggestSameRole(brief, analysis)?.role
      const contract: ProblemContract = {
        ...brief,
        successCriteria: analysis.doneWhen,
        nonGoals: [],
        context: `${brief.context}\nCrew mode: ${roleHint ? `same role (${roleHint}), independent copy-on-write` : analysis.coordination}. Lanes: ${
          roleHint
            ? "none; every seat owns the whole problem"
            : analysis.workstreams.map((lane: { name: string }) => lane.name).join(", ")
        }. Oracle: ${analysis.oracle.observable}. Baseline: ${analysis.oracle.baseline}. Negative close: ${analysis.negativeWhen.join("; ")}.`,
      }
      const requested = Number.isFinite(requestedAgents)
        ? Math.min(resolveConfig({}).hardMaxAgents, Math.max(2, Math.round(requestedAgents as number)))
        : undefined
      const started = await this.startField(
        contract,
        {
          contestants: requested ?? analysis.recommendedAgents,
          maxDurationMinutes: requestedMinutes,
          sameRole: requestedRole,
        },
        parentSessionID,
      )
      const startedRun = this.fields.get(started.runID)
      const count = startedRun?.snapshot.members.length ?? requested ?? analysis.recommendedAgents
      const actualRole = startedRun?.snapshot.sameRole ?? requestedRole
      const workspace =
        started.workspaceMode === "shared"
          ? " Shared workspace: copy-on-write is unavailable at this root, so writes and launches are serialized."
          : " Copy-on-write workspace: each seat has its own writable copy."
      return `Arena ${started.runID} started with ${count} agents in ${
        actualRole ? `same-role (${actualRole})` : analysis.coordination
      } mode.${workspace} Follow it in the Arena tab.`
    } catch (error) {
      return `Arena could not start: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * `/arena continue`: keep the live agents and history for a new mission.
   * If the previous field has already closed, the same crew labels and
   * personalities are restarted because sealed sessions cannot be reopened;
   * the prior facts and contract travel into the new run.
   */
  private async continueFromCommand(
    mission: string,
    parentSessionID: string,
    requestedMinutes?: number,
  ): Promise<string> {
    if (mission.length < 8) return "Usage: /arena continue [--minutes M] <new mission>."
    const active = await this.activeFieldRun(parentSessionID).catch(() => undefined)
    if (active) {
      const run = this.fields.get(active)
      if (run) {
        const result = await run.continueWith({ mission, maxDurationMinutes: requestedMinutes })
        return result.ok
          ? `Arena ${active} continued with the same ${run.snapshot.members.length} agent(s): ${mission}`
          : `Arena ${active} could not continue: ${result.text}`
      }
      return `Arena ${active} is marked running but is not live in this process. Stop it from the Arena panel, then use /arena continue again.`
    }
    const latest = await this.deps.storage.get(`arena:field/latest/${parentSessionID}`).catch(() => undefined)
    if (typeof latest !== "string") return "No previous Arena in this session. Use /arena <mission> to start one."
    const rawMeta = await this.deps.storage.get(`arena:field/meta/${latest}`).catch(() => undefined)
    const rawState = await this.deps.storage.get(`arena:field/${latest}`).catch(() => undefined)
    if (typeof rawMeta !== "string" || typeof rawState !== "string") {
      return `Arena ${latest} has no reusable metadata; start a new field.`
    }
    let meta: { contract?: ProblemContract; plan?: ArenaPlan } | undefined
    let state: FieldState | undefined
    try {
      meta = JSON.parse(rawMeta) as { contract?: ProblemContract; plan?: ArenaPlan }
      state = JSON.parse(rawState) as FieldState
    } catch {
      return `Arena ${latest} metadata is unreadable; start a new field.`
    }
    const plan = meta?.plan
    if (!plan || !Array.isArray(plan.crew) || plan.crew.length === 0) {
      return `Arena ${latest} has no reusable crew; start a new field.`
    }
    const previous = state?.contract ?? meta.contract
    const crew: CrewSpec[] = plan.crew.map((seat) => ({
      name: seat.name,
      role: seat.role,
      brief: seat.brief,
      agent: seat.agent,
    }))
    const priorFacts = (state?.facts ?? [])
      .filter((fact) => fact.status !== "superseded")
      .slice(-12)
      .map((fact) => `- ${fact.id} [${fact.status}] ${fact.claim}`)
      .join("\n")
    const contract: ProblemContract = {
      objective: mission,
      constraints: previous?.constraints ?? [],
      successCriteria: [...(previous?.successCriteria ?? []), `new mission: ${mission}`],
      nonGoals: previous?.nonGoals ?? [],
      context: `Continuing from Arena ${latest}: ${previous?.objective ?? "previous mission"}\nNew mission: ${mission}\n${previous?.context ?? ""}${priorFacts ? `\nPrior facts from the closed run:\n${priorFacts}` : ""}`.trim(),
    }
    const foremanModel = plan.foremanModel
      ? `${plan.foremanModel.providerID}/${plan.foremanModel.id}`
      : undefined
    const started = await this.startField(
      contract,
      {
        crew,
        contestants: crew.length,
        sameRole: plan.sameRole,
        workspaceMode: plan.workspaceMode,
        network: plan.allowNetwork,
        toolPolicy: plan.toolPolicy ?? "all",
        maxDurationMinutes: requestedMinutes ?? 0,
        checkEveryMinutes: Math.round((plan.checkEveryMs ?? 120_000) / 60_000),
        mentionTimeoutSeconds: Math.round((plan.mentionTimeoutMs ?? 60_000) / 1_000),
        leaseMinutes: Math.round((plan.intentLeaseMs ?? 600_000) / 60_000),
        foremanAgent: plan.foremanAgent,
        foremanModel,
      },
      parentSessionID,
    )
    return `Arena ${started.runID} continued with the previous crew (${crew.length} agent(s), same names and history; the old field ${latest} had closed).`
  }

  /** Start the continuous field: named peers, one bus, a referee and a gate. */
  async startField(
    contract: ProblemContract,
    options: ArenaOptions,
    parentSessionID: string,
  ): Promise<{ runID: string; text: string; workspaceMode: "shared" | "copy" }> {
    parentSessionID = await this.rootSession(parentSessionID)
    if (contract.objective.trim().length < 8) throw new Error("objective must be a sentence describing the outcome")
    const active = await this.activeFieldRun(parentSessionID)
    if (active) throw new Error(`this session already has an active field: ${active}. Stop it first or use arena status.`)
    const preview = await this.preview(contract, options, parentSessionID)
    const plan = preview.plan
    // A home/drive root cannot give each seat a private worktree. Starting ten
    // same-role seats there turns one shared tree into a queue, so refuse the
    // copy-on-write plan before any session or worktree is created.
    if (plan.sameRole && plan.workspaceMode === "copy" && plan.crew.length > 2 && this.deps.workspace.canIsolate) {
      const isolated = await this.deps.workspace.canIsolate(this.deps.root).catch(() => true)
      if (!isolated) {
        throw new Error(
          `copy-on-write is unavailable at this root (home/drive). A same-role room above 2 seats would serialize on one shared tree; open a project folder or start 2 agents.`,
        )
      }
    }
    const prior = await this.loadPrior(contract.objective, parentSessionID)
    const runID = makeID()
    const parent = await this.deps.parentInfo(parentSessionID).catch(() => undefined)
    const sessions = new Map<string, string>()
    // The orchestrator makes the working directory a repository before any seat
    // exists. Home/drive roots are ignored; a failed init falls through to the
    // shared or shadow path instead of blocking the field.
    if (this.deps.workspace.ensureRepository) {
      await this.deps.workspace.ensureRepository(this.deps.root).catch(() => false)
    }
    const sharedWorkspace = await this.deps.workspace.create(this.deps.root, runID, "shared", false)
    const copyOnWrite = plan.workspaceMode === "copy"
    const workspaces = new Map<string, Workspace>()
    const members: {
      label: string
      agent: string
      model?: ModelRef
      stance: { id: string; name: string; objective: string; cooperation: string }
      workstream?: Workstream
      sessionID: string
      workspacePath?: string
      workspaceBranch?: string
      workspaceIsolated?: boolean
      workspaceRepoRoot?: string
      workspaceShadow?: boolean
    }[] = []
    for (const seat of plan.crew) {
      let workspace = sharedWorkspace
      if (copyOnWrite) {
        workspace = await this.deps.workspace.create(this.deps.root, runID, seat.name, true)
        workspaces.set(seat.name, workspace)
      }
      const sessionID = await this.deps.runtime.createSession({
        title: `Arena ${runID} ${seat.name}`,
        agent: seat.agent,
        parentID: parentSessionID,
        model: seat.model ?? parent?.model,
        location: workspace.isolated ? { directory: workspace.path } : undefined,
        metadata: { arenaRole: "field", arenaLabel: seat.name, arenaRun: runID },
      })
      sessions.set(seat.name, sessionID)
      this.fieldSessions.set(sessionID, { runID, label: seat.name, parentSessionID })
      this.sessionParents.set(sessionID, parentSessionID)
      this.bindings.set(sessionID, { runID, label: seat.name, role: "contestant", depth: 0 })
      await this.deps.storage.set(
        `arena:field/bind/${sessionID}`,
        JSON.stringify({ runID, label: seat.name, parentSessionID }),
      )
      members.push({
        label: seat.name,
        agent: seat.agent,
        model: seat.model,
        stance: {
          id: seat.role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "independent",
          name: seat.role,
          objective: seat.brief,
          cooperation: "",
        },
        workstream: seat.workstream,
        sessionID,
        workspacePath: workspace.path,
        workspaceBranch: workspace.branch,
        workspaceIsolated: workspace.isolated,
        workspaceRepoRoot: workspace.repoRoot,
        workspaceShadow: workspace.shadow,
      })
    }
    let foremanSessionID = await this.deps.runtime
      .createSession({
        title: `Arena ${runID} ${FOREMAN_NAME}`,
        agent: plan.foremanAgent,
        parentID: parentSessionID,
        model: plan.foremanModel,
        metadata: { arenaRole: "foreman", arenaRun: runID },
      })
      .catch(() => undefined)
    if (!foremanSessionID && plan.foremanModel?.variant) {
      foremanSessionID = await this.deps.runtime
        .createSession({
          title: `Arena ${runID} ${FOREMAN_NAME}`,
          agent: plan.foremanAgent,
          parentID: parentSessionID,
          model: { ...plan.foremanModel, variant: undefined },
          metadata: { arenaRole: "foreman", arenaRun: runID },
        })
        .catch(() => undefined)
    }
    if (foremanSessionID) {
      this.fieldSessions.set(foremanSessionID, { runID, label: FOREMAN_NAME, parentSessionID })
      this.sessionParents.set(foremanSessionID, parentSessionID)
      await this.injectReferee(foremanSessionID, contract)
    }
    const room = await this.roomFor(parentSessionID)
    if (room) {
      for (const member of members) {
        room.addParticipant({
          label: member.label,
          name: member.label,
          role: "agent",
          agent: member.agent,
          stance: member.stance.name,
          model: member.model ? `${member.model.providerID}/${member.model.id}` : undefined,
          sessionID: member.sessionID,
          runID,
          status: "idle",
        })
      }
      room.setActiveRun(runID)
      room.setTitle(contract.objective)
      room.reopen()
      room.setGoal({ text: contract.objective, by: ROOM_LABELS.orchestrator, status: "proposed", at: Date.now() })
      room.post({
        author: "System",
        authorRole: "system",
        kind: "lifecycle",
        text: `Field ${runID} started: ${members.map((member) => member.label).join(", ")} with ${FOREMAN_NAME} as referee.`,
        to: "all",
        runID,
      })
      await this.saveRoom(room)
    }
    const effectiveCopy = copyOnWrite && [...workspaces.values()].some((ws) => ws.isolated)
    this.fieldWorkspaces.set(runID, workspaces)
    const now = Date.now()
    let state = openField({
      id: runID,
      parentSessionID,
      contract,
      members,
      coordination: plan.coordination,
      crewReason: plan.crewReason,
      oracle: plan.oracle,
      prior: prior
        ? { runID: prior.runID, objective: prior.objective, at: prior.at, facts: prior.facts.length, routes: prior.routes }
        : undefined,
      foremanSessionID,
      workspaceRoot: sharedWorkspace.path,
      // A non-git root cannot provide real copies; fall back to shared mode.
      copyOnWrite: effectiveCopy,
      allowNetwork: plan.allowNetwork,
      toolPolicy: plan.toolPolicy,
      sameRole: plan.sameRole,
      now,
      budgetMs: plan.maxDurationMinutes * 60_000,
      checkEveryMs: plan.checkEveryMs,
      maxTurns: plan.maxTurns,
      maxForemanTurns: plan.maxForemanTurns,
    })
    state = seedPrior(state, prior, now)
    await this.deps.storage.set(`arena:field/${runID}`, JSON.stringify(state))
    await this.deps.storage.set(`arena:field/meta/${runID}`, JSON.stringify({ contract, plan }))
    await this.deps.storage.set(`arena:field/latest/${parentSessionID}`, runID)
    await this.deps.storage.set(`arena:field/sessions/${runID}`, JSON.stringify(Object.fromEntries(sessions)))
    seenRuns().add(runID)
    const run = new FieldRun(this.fieldDeps(runID, parentSessionID, plan, sharedWorkspace, workspaces), state)
    this.fields.set(runID, run)
    void run.start().catch(() => undefined)
    const names = members.map((member) => member.label).join(", ")
    return {
      runID,
      workspaceMode: effectiveCopy ? "copy" : "shared",
      text: `Arena ${runID} field started: ${plan.crew.length} agents (${names}) in ${
        plan.sameRole
          ? `same-role (${plan.sameRole}${plan.sameRoleInferred ? ", inferred" : ""})`
          : (plan.coordination ?? "split")
      } mode, Vera the referee. They work continuously, coordinate in the room, and claim with evidence. Referee checks every ${Math.round(plan.checkEveryMs / 60_000)}m. Verification: ${contract.verificationCommand ?? "none"}.${
        plan.workspaceMode === "copy" && !effectiveCopy
          ? " Copy-on-write is unavailable at this root (home/drive or non-git); the crew is using the shared tree. Open a project folder to get isolated worktrees."
          : plan.sameRole
            ? " Each seat has its own writable copy and reads the shared baseline."
            : ""
      } You are the coordinator, not a worker: do not investigate or run debuggers. Use arena status/read to inspect the room and arena chat or steer to guide the crew. Answer the User. Use arena status or the Arena tab to follow it.`,
    }
  }

  /**
   * The one gate every field prompt goes through. A sealed agent stays silent
   * until the coordinator explicitly wakes it; the wake unseals only after the
   * prompt is accepted by the host.
   */
  /** The referee role is stable; inject it once instead of on every check. */
  private async injectReferee(sessionID: string, contract: ProblemContract): Promise<void> {
    await this.deps.runtime
      .inject(sessionID, "arena.referee", { text: refereeRole({ contract }) })
      .catch(() => undefined)
  }

  private async promptField(
    sessionID: string,
    text: string,
    options?: { delivery?: "steer" | "queue"; resume?: boolean; files?: { data: string; mime: string; name?: string }[] },
  ): Promise<void> {
    const seal = sealOf(sessionID)
    if (seal) {
      throw new Error(
        seal.reason === "left"
          ? `Arena agent ${seal.label} left the field and is permanently sealed. No message can reach it again.`
          : `Arena agent ${seal.label} is sealed (${seal.reason}). Only the User can stop the field; no one can wake a left agent.`,
      )
    }
    await this.deps.runtime.prompt(sessionID, text, options)
  }

  private fieldDeps(
    runID: string,
    parentSessionID: string,
    plan: ArenaPlan,
    sharedWorkspace: Workspace,
    workspaces: Map<string, Workspace>,
  ): FieldDeps {
    const workspace = Promise.resolve(sharedWorkspace)
    return {
      now: () => Date.now(),
      parentSessionID,
      prompt: (sessionID, text, options) => this.promptField(sessionID, text, options),
      wait: (sessionID, timeoutMs) => this.deps.runtime.wait(sessionID, timeoutMs),
      info: async (sessionID) => {
        try {
          const info = await this.deps.runtime.info(sessionID)
          return { outcome: info.outcome, updatedAt: info.updatedAt }
        } catch {
          return undefined
        }
      },
      jobFor: (label) => {
        const running = [...this.jobs.values()]
          .filter((job) => job.runID === runID && job.label === label && job.status === "running")
          .sort((left, right) => Number(right.foreground === true) - Number(left.foreground === true) || left.startedAt - right.startedAt)
        const job = running[0]
        return job ? { id: job.id, startedAt: job.startedAt, foreground: job.foreground } : undefined
      },
      stopJob: async (id) => {
        const job = this.jobs.get(id)
        if (!job) return
        void killProcessTree(job.pid)
        job.status = "stopped"
        job.endedAt = Date.now()
        await this.fields.get(job.runID)?.releaseLaunch(job.label, job.id).catch(() => undefined)
      },
      stallAfterMs: 150_000,
      finalText: (sessionID) => this.deps.runtime.finalText(sessionID),
      usage: (sessionID) => this.deps.runtime.usage(sessionID),
      interrupt: (sessionID) => this.deps.runtime.interrupt(sessionID),
      verify: async (command, label, timeoutMs) => {
        const ws = workspaces.get(label) ?? (await workspace)
        const result = await this.deps.workspace.verify(ws, command, label, timeoutMs)
        return { ok: result.passed, output: result.output }
      },
      post: async (input) => {
        const room = await this.roomFor(parentSessionID, false)
        if (!room) return { id: "0" }
        const message = room.post({
          author: input.author,
          authorRole: input.authorRole,
          kind: input.kind,
          text: input.text,
          to: input.to ?? "all",
          mentions: input.mentions,
          order: input.order,
          private: input.private,
          replyTo: input.replyTo,
          runID,
          meta: input.detail ? { detail: input.detail } : undefined,
        })
        await this.saveRoom(room)
        return { id: message.id }
      },
      save: (state) => this.saveField(state),
      remember: (state) => this.rememberField(state),
      stopJobs: (labels) => this.stopJobs(runID, labels),
      cleanup: async (members) => {
        this.stopJobs(runID)
        this.fieldWorkspaces.delete(runID)
        await Promise.all(
          members.map(async (member) => {
            const ws = workspaces.get(member.label)
            if (!ws?.isolated) return
            await this.deps.workspace.remove(this.deps.root, ws).catch(() => undefined)
          }),
        )
        await this.deps.workspace.cleanupRun?.(runID).catch(() => undefined)
      },
      flushDelayMs: plan.flushDelayMs,
      coordinatorDigestMs: 90_000,
      maxCoordinatorOrders: plan.maxCoordinatorOrders ?? 16,
      coordinatorMinIntervalMs: plan.coordinatorMinIntervalMs ?? 30_000,
      coordinatorMaxChars: plan.coordinatorMaxChars ?? 600,
      maxExperiments: plan.maxExperiments ?? 0,
      decideMinutes: plan.decideMinutes ?? 0,
      maxNoProgressMinutes: plan.maxNoProgressMinutes ?? 20,
      quietMs: 90_000,
      turnTimeoutMs: plan.contestantTimeoutMs,
      verifyTimeoutMs: plan.verifyTimeoutMs,
      foremanTimeoutMs: plan.foremanTimeoutMs,
      mentionTimeoutMs: plan.mentionTimeoutMs,
      intentLeaseMs: plan.intentLeaseMs,
      cancelled: () => !this.fields.has(runID),
    }
  }

  /** Re-seal terminal members from any persisted state, including after a restart. */
  private sealState(state: FieldState): void {
    const closed = state.status === "done"
    if (closed && state.foremanSessionID) {
      sealSession(state.foremanSessionID, { label: FOREMAN_NAME, runID: state.id, reason: "field-closed", at: Date.now() })
    }
    for (const member of state.members) {
      if (closed) {
        // A left member keeps its stronger, permanent seal.
        sealSession(member.sessionID, {
          label: member.label,
          runID: state.id,
          reason: member.status === "left" ? "left" : "field-closed",
          at: Date.now(),
        })
      } else if (member.status === "left" || member.status === "done" || member.status === "stopped" || member.status === "failed") {
        sealSession(member.sessionID, {
          label: member.label,
          runID: state.id,
          reason: member.status === "left" ? "left" : member.status,
          at: Date.now(),
        })
      }
    }
  }

  private async saveField(state: FieldState): Promise<void> {
    await this.deps.storage.set(`arena:field/${state.id}`, JSON.stringify(state))
    this.sealState(state)
    const closed = state.status === "done"
    const room = await this.roomFor(state.parentSessionID, false)
    if (!room) return
    for (const member of state.members) {
      room.addParticipant({ label: member.label, name: member.label, role: "agent", runID: state.id })
      const shown =
        closed && !["left", "stopped", "failed"].includes(member.status) ? "done" : member.status
      room.setStatus(member.label, shown)
    }
    await this.saveRoom(room)
  }

  private async rememberField(state: FieldState): Promise<void> {
    if (!state.report) return
    const prior = priorFromReport({
      objective: state.contract.objective,
      runID: state.id,
      at: Date.now(),
      report: state.report,
      facts: state.facts ?? [],
    })
    const encoded = JSON.stringify(prior)
    await this.deps.storage.set(objectiveKey(state.contract.objective), encoded).catch(() => undefined)
    // A follow-up often restates the same goal in different words ("still not
    // completed..."). Keep a per-session fallback so those fields inherit the
    // dead ends instead of rediscovering them.
    await this.deps.storage.set(`arena:field/prior/${state.parentSessionID}`, encoded).catch(() => undefined)
  }

  private async loadPrior(objective: string, parentSessionID?: string): Promise<PriorMemory | undefined> {
    const keys = [objectiveKey(objective)]
    if (parentSessionID) keys.push(`arena:field/prior/${parentSessionID}`)
    for (const key of keys) {
      const raw = await this.deps.storage.get(key).catch(() => undefined)
      if (typeof raw !== "string") continue
      try {
        const parsed = JSON.parse(raw) as PriorMemory
        if (!parsed || !Array.isArray(parsed.facts)) continue
        return parsed
      } catch {
        // Try the next key.
      }
    }
    return undefined
  }

  private async activeFieldRun(parentSessionID: string): Promise<string | undefined> {
    const id = await this.deps.storage.get(`arena:field/latest/${parentSessionID}`)
    if (typeof id !== "string") return undefined
    const raw = await this.deps.storage.get(`arena:field/${id}`)
    const state = readStored<FieldState>(raw)
    if (!state) return undefined
    return ["running", "paused", "stopping"].includes(state.status) ? id : undefined
  }

  async fieldBoard(parentSessionID: string): Promise<FieldBoard | undefined> {
    parentSessionID = await this.rootSession(parentSessionID)
    const runID = await this.deps.storage.get(`arena:field/latest/${parentSessionID}`)
    if (typeof runID !== "string") return undefined
    const live = this.fields.get(runID)
    let board: FieldBoard | undefined
    if (live) {
      board = live.board()
    } else {
      const raw = await this.deps.storage.get(`arena:field/${runID}`)
      const state = readStored<FieldState>(raw)
      if (!state) return undefined
      board = boardOf(state, Date.now())
    }
    try {
      const room = await this.roomFor(parentSessionID, false)
      const snapshot = room?.toJSON()
      return { ...board, roomUpdatedAt: snapshot?.updatedAt ?? 0, messageCount: snapshot?.messages.length ?? 0 }
    } catch (error) {
      console.error("[arena] board room failed", error)
      return board
    }
  }

  async fieldStatus(parentSessionID: string): Promise<string> {
    const board = await this.fieldBoard(parentSessionID)
    if (!board) return "No field run for this session yet."
    const room = await this.roomFor(parentSessionID, false)
    return this.describeBoard(board, room?.toJSON().messages.slice(-4))
  }

  private describeBoard(board: FieldBoard, recent?: readonly RoomMessage[]): string {
    const agents = board.members
      .map(
        (member) =>
          `${member.label} ${member.status}${member.leftBy ? ` (left by ${member.leftBy})` : ""}${
            member.waitingFor ? ` waiting on ${member.waitingFor}` : ""
          }`,
      )
      .join(", ")
    const lines = [
      `Arena ${board.runID} | field | ${board.status}${board.stopReason ? ` (${board.stopReason})` : ""}`,
      `Objective: ${oneLine(board.objective, 300)}`,
      `Agents: ${agents}.`,
      `${board.posts} posts, ${board.deadEnds} dead ends, ${board.claims} claim(s)${board.openMentions ? `, ${board.openMentions} open ask(s)` : ""}.`,
      board.delivery
        ? `Delivery: ${board.delivery.delivered}/${board.delivery.queued} delivered, p50 ${board.delivery.p50Ms ?? "?"}ms, p90 ${board.delivery.p90Ms ?? "?"}ms, ${board.delivery.truncated} truncated.`
        : "",
      board.referee
        ? `Referee: ${board.referee.name} ${board.referee.status}, ${board.referee.checks} check(s)${board.referee.maxChecks > 0 ? ` of ${board.referee.maxChecks}` : ", no cap"}${board.referee.lastDecision ? `, last ${board.referee.lastDecision}` : ""}.`
        : "",
      `Time: ${Math.round(board.elapsedMs / 60_000)}m${board.budgetMs > 0 ? `/${Math.round(board.budgetMs / 60_000)}m` : " (continuous)"}.`,
      board.closed ? `Closed: ${board.closed.decision}: ${board.closed.reason}` : "",
      recent && recent.length > 0
        ? `Recent room:\n${recent.map((message) => `- #${message.id} [${message.kind}] ${message.author}: ${oneLine(message.text, 200)}`).join("\n")}`
        : "",
    ]
    return lines.filter(Boolean).join("\n")
  }

  async stopField(parentSessionID: string, runID?: string): Promise<string | undefined> {
    parentSessionID = await this.rootSession(parentSessionID)
    const latest = runID ?? (await this.deps.storage.get(`arena:field/latest/${parentSessionID}`))
    if (typeof latest !== "string") return undefined
    const raw = await this.deps.storage.get(`arena:field/${latest}`)
    if (typeof raw !== "string") return undefined
    let state: FieldState
    try {
      state = JSON.parse(raw) as FieldState
    } catch {
      return undefined
    }
    if (state.status === "done") return `Field ${latest} already finished (${state.stopReason ?? state.closed?.decision ?? "done"}).`
    const live = this.fields.get(latest)
    if (live) {
      await live.stop("stopped", "the user stopped the field")
      this.markClosing(parentSessionID)
      this.fields.delete(latest)
      state = live.snapshot
    } else {
      state = finishField(state, "stopped", "the user stopped the field", Date.now())
      this.markClosing(parentSessionID)
      await Promise.all(
        state.members.map(async (member) => {
          if (!member.workspacePath || member.workspaceIsolated !== true) return
          await this.deps.workspace
            .remove(this.deps.root, {
              label: member.label,
              path: member.workspacePath,
              branch: member.workspaceBranch,
              isolated: true,
            })
            .catch(() => undefined)
        }),
      )
      await this.deps.storage.set(`arena:field/${latest}`, JSON.stringify(state))
    }
    this.stopJobs(latest)
    this.fieldWorkspaces.delete(latest)
    await this.deps.workspace.cleanupRun?.(latest).catch(() => undefined)
    let interrupted = 0
    for (const member of state.members) {
      sealSession(member.sessionID, {
        label: member.label,
        runID: latest,
        reason: member.status === "left" ? "left" : "field-closed",
        at: Date.now(),
      })
    }
    if (state.foremanSessionID) {
      sealSession(state.foremanSessionID, {
        label: FOREMAN_NAME,
        runID: latest,
        reason: "field-closed",
        at: Date.now(),
      })
    }
    const sessions = new Set(state.members.map((member) => member.sessionID))
    if (state.foremanSessionID) sessions.add(state.foremanSessionID)
    for (const sessionID of sessions) {
      await this.deps.runtime.interrupt(sessionID).catch(() => undefined)
      interrupted += 1
    }
    const room = await this.roomFor(parentSessionID, false)
    if (room) {
      room.clearTyping()
      room.post({
        author: ROOM_LABELS.user,
        authorRole: "user",
        kind: "order",
        text: `STOP: the user stopped field ${latest}`,
        to: "all",
        order: true,
        runID: latest,
      })
      room.close()
      await this.saveRoom(room)
      await this.deps.synthetic(parentSessionID, `Arena field ${latest} stopped: ${interrupted} session(s) interrupted.`).catch(() => undefined)
    }
    return `Field ${latest} stopped: ${interrupted} session(s) interrupted.`
  }

  private async resumeFields(): Promise<void> {
    const seen = seenRuns()
    for (const room of this.rooms.values()) {
      const latest = await this.deps.storage.get(`arena:field/latest/${room.parentSessionID}`).catch(() => undefined)
      // A closed field clears activeRunID but its latest state is still the
      // authority for sealing those sessions after a fresh process.
      const runID = room.toJSON().activeRunID ?? (typeof latest === "string" ? latest : undefined)
      if (!runID || this.fields.has(runID)) continue
      const raw = await this.deps.storage.get(`arena:field/${runID}`).catch(() => undefined)
      if (typeof raw !== "string") continue
      let state: FieldState
      try {
        state = JSON.parse(raw) as FieldState
      } catch {
        continue
      }
      // The seal registry is in memory, so a restarted process rebuilds it
      // from the persisted field state before any room traffic can reach them.
      this.sealState(state)
      if (state.status === "done") {
        for (const member of state.members) {
          room.setStatus(member.label, member.status === "stopped" || member.status === "failed" ? member.status : "done")
        }
        room.setActiveRun(undefined)
        await this.saveRoom(room)
        continue
      }
      if (!["running", "paused", "stopping"].includes(state.status)) continue
      // Fields created before the standing-referee change used a four-check
      // cap. Keep Vera on watch when an existing field resumes.
      if (state.maxForemanTurns === 4) state = { ...state, maxForemanTurns: 0 }
      const metaRaw = await this.deps.storage.get(`arena:field/meta/${runID}`).catch(() => undefined)
      let meta: { contract: ProblemContract; plan: ArenaPlan } | undefined
      if (typeof metaRaw === "string") {
        try {
          meta = readStored<{ contract: ProblemContract; plan: ArenaPlan }>(metaRaw)
        } catch {
          meta = undefined
        }
      }
      if (!meta) {
        const stopped = finishField(state, "interrupted", "the field state could not be resumed", Date.now())
        await this.deps.storage.set(`arena:field/${runID}`, JSON.stringify(stopped)).catch(() => undefined)
        room.post({
          author: "System",
          authorRole: "system",
          kind: "lifecycle",
          text: `Arena ${runID} was interrupted by a reload and could not resume. Start a new field; the transcript stays.`,
          to: "all",
          runID,
        })
        room.setActiveRun(undefined)
        await this.saveRoom(room)
        continue
      }
      for (const member of state.members) {
        // A left agent is never recreated on a reload.
        if (member.status === "left") {
          sealSession(member.sessionID, {
            label: member.label,
            runID,
            reason: "left",
            at: Date.now(),
          })
          continue
        }
        let alive = true
        try {
          await this.deps.runtime.info(member.sessionID)
        } catch {
          alive = false
        }
        let sessionID = member.sessionID
        if (!alive) {
          const created = await this.deps.runtime
            .createSession({
              title: `Arena ${runID} ${member.label} (resumed)`,
              agent: member.agent,
              parentID: state.parentSessionID,
              model: member.model,
              metadata: { arenaRole: "field", arenaLabel: member.label, arenaRun: runID },
            })
            .catch(() => undefined)
          if (!created) continue
          sessionID = created
          state = setSession(state, member.label, created)
        }
        // Register every member, not only the recreated ones: without this the
        // agents' arena_bus calls lose the run after a reload.
        await this.registerFieldSession(sessionID, runID, member.label, state.parentSessionID, room)
      }
      if (state.foremanSessionID) {
        try {
          await this.deps.runtime.info(state.foremanSessionID)
        } catch {
          state = { ...state, foremanSessionID: undefined }
        }
      }
      if (!state.foremanSessionID) {
        let foremanSessionID = await this.deps.runtime
          .createSession({
            title: `Arena ${runID} ${FOREMAN_NAME} (resumed)`,
            agent: meta.plan.foremanAgent,
            parentID: state.parentSessionID,
            model: meta.plan.foremanModel,
            metadata: { arenaRole: "foreman", arenaRun: runID },
          })
          .catch(() => undefined)
        if (!foremanSessionID && meta.plan.foremanModel?.variant) {
          foremanSessionID = await this.deps.runtime
            .createSession({
              title: `Arena ${runID} ${FOREMAN_NAME} (resumed)`,
              agent: meta.plan.foremanAgent,
              parentID: state.parentSessionID,
              model: { ...meta.plan.foremanModel, variant: undefined },
              metadata: { arenaRole: "foreman", arenaRun: runID },
            })
            .catch(() => undefined)
        }
        if (foremanSessionID) {
          state = { ...state, foremanSessionID }
          this.fieldSessions.set(foremanSessionID, { runID, label: FOREMAN_NAME, parentSessionID: state.parentSessionID })
          this.sessionParents.set(foremanSessionID, state.parentSessionID)
        }
      }
      if (state.foremanSessionID) await this.injectReferee(state.foremanSessionID, state.contract)
      state = { ...state, status: "running" }
      const hot = seen.has(runID)
      if (!hot) {
        room.post({
          author: "System",
          authorRole: "system",
          kind: "lifecycle",
          text: `Arena ${runID} resumed after a reload.`,
          to: "all",
          runID,
        })
      }
      await this.deps.storage.set(`arena:field/${runID}`, JSON.stringify(state)).catch(() => undefined)
      await this.deps.storage
        .set(
          `arena:field/sessions/${runID}`,
          JSON.stringify(Object.fromEntries(state.members.map((member) => [member.label, member.sessionID]))),
        )
        .catch(() => undefined)
      await this.saveRoom(room)
      const sharedWorkspace = await this.deps.workspace.create(this.deps.root, runID, "shared", false)
      const workspaces = new Map<string, Workspace>()
      for (const member of state.members) {
        if (!member.workspacePath) continue
        workspaces.set(member.label, {
          label: member.label,
          path: member.workspacePath,
          branch: member.workspaceBranch,
          isolated: member.workspaceIsolated === true,
          repoRoot: member.workspaceRepoRoot,
          shadow: member.workspaceShadow,
        })
      }
      this.fieldWorkspaces.set(runID, workspaces)
      const run = new FieldRun(
        this.fieldDeps(runID, state.parentSessionID, meta.plan, sharedWorkspace, workspaces),
        state,
      )
      this.fields.set(runID, run)
      seen.add(runID)
      if (hot) {
        // The sessions and their turns survived a plugin reload. Take over the
        // tick loop without re-prompting every agent or repeating lifecycle text.
        void run.adopt().catch(() => undefined)
      } else {
        void run.resume().catch(() => undefined)
      }
    }
  }

  async sweepFields(): Promise<void> {
    for (const [runID, run] of [...this.fields]) {
      if (run.snapshot.status !== "running") continue
      const parentSessionID = run.snapshot.parentSessionID
      const room = await this.roomFor(parentSessionID, false)
      for (const member of run.snapshot.members) {
        if (!member.sessionID) continue
        let alive = true
        try {
          await this.deps.runtime.info(member.sessionID)
        } catch {
          alive = false
        }
        if (alive) continue
        const sessionID = await this.deps.runtime
          .createSession({
            title: `Arena ${runID} ${member.label} (resumed)`,
            agent: member.agent,
            parentID: parentSessionID,
            model: member.model,
            metadata: { arenaRole: "field", arenaLabel: member.label, arenaRun: runID },
          })
          .catch(() => undefined)
        if (!sessionID) continue
        await this.registerFieldSession(sessionID, runID, member.label, parentSessionID, room)
        await run.attach(member.label, sessionID)
        if (room) {
          room.post({
            author: "System",
            authorRole: "system",
            kind: "lifecycle",
            text: `${member.label} lost its session and was resumed.`,
            to: "all",
            runID,
          })
          await this.saveRoom(room)
        }
      }
    }
  }

  private async registerFieldSession(
    sessionID: string,
    runID: string,
    label: string,
    parentSessionID: string,
    room: ArenaRoom | undefined,
  ): Promise<void> {
    this.fieldSessions.set(sessionID, { runID, label, parentSessionID })
    this.sessionParents.set(sessionID, parentSessionID)
    this.bindings.set(sessionID, { runID, label, role: "contestant", depth: 0 })
    await this.deps.storage
      .set(`arena:field/bind/${sessionID}`, JSON.stringify({ runID, label, parentSessionID }))
      .catch(() => undefined)
    room?.addParticipant({ label, name: label, role: "agent", sessionID, runID, status: "idle" })
  }

  async roomSnapshot(parentSessionID: string): Promise<RoomSnapshot> {
    parentSessionID = await this.rootSession(parentSessionID)
    const room = await this.roomFor(parentSessionID)
    const snapshot = room ? room.toJSON() : new ArenaRoom(parentSessionID).toJSON()
    return JSON.parse(JSON.stringify(snapshot)) as RoomSnapshot
  }

  async setTypingBySession(sessionID: string, typing: boolean): Promise<void> {
    // A sealed session never enters a new turn, so its idle/typing hooks must
    // not flush an inbox, nudge it, or mark it working again.
    if (isSealed(sessionID)) return
    const fieldBinding = this.fieldSessions.get(sessionID)
    if (fieldBinding) {
      const run = this.fields.get(fieldBinding.runID)
      if (run) {
        if (typing) await run.noteTurnStart(sessionID).catch(() => undefined)
        else await run.noteIdle(sessionID).catch(() => undefined)
      }
    }
    const parent = this.sessionParents.get(sessionID)
    if (!parent) return
    const room = await this.roomFor(parent, false)
    if (!room) return
    const participant = room.participantBySession(sessionID)
    if (!participant || participant.role !== "agent") return
    if (participant.typing === typing) return
    room.setTyping(participant.label, typing)
    if (!typing && participant.status === "working") room.setStatus(participant.label, "idle")
    await this.saveRoom(room).catch(() => undefined)
  }

  async chat(input: RoomChatInput): Promise<RoomChatResult | string> {
    if (input.text.trim().length === 0 && (input.attachments ?? []).length === 0) return "chat needs text or a file."
    const attachments = (input.attachments ?? []).slice(0, 4)
    if (attachments.some((attachment) => !attachment?.data || attachment.data.length > 8_000_000)) {
      return "an attachment is too large (max 4 files, 8 MB each)"
    }
    let parentSessionID = input.parentSessionID
    if (input.runID) {
      const raw = await this.deps.storage.get(`arena:field/${input.runID}`).catch(() => undefined)
      if (typeof raw !== "string") return `No field ${input.runID}.`
      try {
        parentSessionID = readStored<FieldState>(raw)?.parentSessionID
      } catch {
        return `Field ${input.runID} is unreadable.`
      }
    }
    if (!parentSessionID) return "chat needs a session or run id."
    parentSessionID = await this.rootSession(parentSessionID)
    const room = await this.roomFor(parentSessionID)
    if (!room) return "No room for this session."
    // The author is derived from the caller, not from a caller-supplied label.
    // A field-bound session can never impersonate the User; the coordinator can
    // never post with authorRole=user just by asking for it.
    const callerBinding = input.callerSessionID ? this.fieldSessions.get(input.callerSessionID) : undefined
    if (callerBinding && !input.panel) {
      return "Field agents speak through arena_bus; they cannot post as the User or the Orchestrator."
    }
    const requestedRole = input.authorRole
    if (!input.panel && requestedRole === "user" && input.authorSessionID && input.authorSessionID !== parentSessionID) {
      return "Only the parent session can post as the User."
    }
    const authorRole: RoomRole = requestedRole ?? (input.authorLabel ? "agent" : "orchestrator")
    if (authorRole === "agent") {
      const bound = input.callerSessionID ? this.fieldSessions.get(input.callerSessionID) : undefined
      if (!bound) return "Agent messages must come through arena_bus from a bound field session."
      if (input.authorLabel && bound.label.toUpperCase() !== input.authorLabel.toUpperCase()) {
        return "The author label does not match the bound session."
      }
    }
    const author =
      authorRole === "user"
        ? ROOM_LABELS.user
        : authorRole === "orchestrator"
          ? ROOM_LABELS.orchestrator
          : (input.authorLabel ?? "Ada").toUpperCase()
    if (!room.participant(author)) {
      room.addParticipant({ label: author, name: author, role: authorRole, status: "working" })
    }
    const commandText = input.text.trim().replace(/^@[A-Za-z][A-Za-z0-9_-]*\s+/, "")
    const command = authorRole === "user" || authorRole === "orchestrator" ? parseRoomCommand(commandText) : undefined
    const targetsAll = input.to === undefined || input.to === "all" || (Array.isArray(input.to) && input.to.includes("all"))
    const principal = authorRole === "user" || authorRole === "orchestrator"
    const goalCommand = principal ? /^goal\s*[:=-]\s*(.+)$/i.exec(commandText) : undefined
    const targetedStop =
      authorRole === "user"
        ? /^(?:please\s+)?(?:stop|halt|remove|kick)\s+([A-Za-z][A-Za-z0-9_-]*)[.!]*$/i.exec(commandText)
        : undefined
    const targetedLeave =
      authorRole === "user"
        ? /^(?:please\s+)?(?:leave|force\s+leave|remove)\s+([A-Za-z][A-Za-z0-9_-]*)[.!]*$/i.exec(commandText)
        : undefined

    if (targetedLeave && !command) {
      return this.forceLeave(parentSessionID, (targetedLeave[1] as string).toUpperCase(), input.text.trim())
    }
    if (
      authorRole === "user" &&
      /^(?:please\s+)?(?:leave|force\s+leave)[.!]*$/i.test(commandText) &&
      Array.isArray(input.to) &&
      !input.to.includes("all")
    ) {
      const results: string[] = []
      for (const target of input.to) {
        results.push(await this.forceLeave(parentSessionID, target, input.text.trim()))
      }
      return results.join("\n")
    }
    if (targetedStop && !command) {
      return this.forceLeave(parentSessionID, (targetedStop[1] as string).toUpperCase(), input.text.trim())
    }
    if (command === "stop" && targetsAll) {
      if (authorRole !== "user") return "Only the User can stop a field. Post a recommendation in the room instead."
      const stopped = await this.stopField(parentSessionID, input.runID)
      if (stopped) {
        const snapshot = await this.roomSnapshot(parentSessionID)
        const message = snapshot.messages[snapshot.messages.length - 1]
        if (message) return { message, delivered: 0, room: snapshot, text: stopped }
      }
      return this.haltRoom({ parentSessionID, author, reason: input.text.trim(), to: "all" })
    }
    if (command === "stop") {
      if (authorRole !== "user") return "Only the User can force an agent to leave."
      const targets = Array.isArray(input.to) ? input.to.filter((target) => target !== "all") : []
      if (targets.length > 0) {
        const results: string[] = []
        for (const target of targets) {
          results.push(await this.forceLeave(parentSessionID, target, input.text.trim()))
        }
        return results.join("\n")
      }
      return this.stopRoomTargets(room, {
        author,
        authorRole,
        text: input.text.trim(),
        to: input.to,
        private: input.private === true,
        runID: input.runID,
      })
    }
    if (room.isClosed()) {
      if (command !== "continue") return "The room is stopped. Say continue to reopen it."
      room.reopen()
      room.clearTyping()
      const notice = room.post({
        author: "System",
        authorRole: "system",
        kind: "lifecycle",
        text: `Room reopened by ${author}.`,
        to: "all",
        runID: input.runID,
      })
      await this.deliverRoom(room, notice)
    }
    const order = input.order ?? false
    const kind: RoomKind = goalCommand ? "goal" : (input.kind ?? (order ? "order" : "chat"))
    const resolvedTo = Array.isArray(input.to)
      ? input.to.map((target) => {
          if (target.toLowerCase() === "all") return target
          const match = room.list().find((participant) => participant.label.toLowerCase() === target.toLowerCase())
          return match?.label ?? target
        })
      : input.to
    const fieldID = await this.activeFieldRun(parentSessionID).catch(() => undefined)
    const fieldRun = fieldID ? this.fields.get(fieldID) : undefined
    const text = goalCommand ? (goalCommand[1] as string).trim() : input.text
    if (fieldRun) {
      // Reject an over-budget or broadcast directive before it enters the room.
      const gateTo: string[] | "all" = Array.isArray(resolvedTo)
        ? resolvedTo
        : resolvedTo && resolvedTo !== "all"
          ? [resolvedTo]
          : "all"
      const gate = fieldRun.checkPrincipal({
        authorRole,
        kind,
        text,
        to: gateTo,
        mentions: gateTo === "all" ? [] : gateTo,
        order,
      })
      if (gate) return gate
    }
    const message = room.post({
      author,
      authorRole,
      kind,
      text,
      to: "all",
      mentions: Array.isArray(resolvedTo) ? resolvedTo : undefined,
      order,
      private: false,
      replyTo: input.replyTo,
      runID: input.runID,
      meta: {
        ...input.meta,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    })
    let delivered = 0
    if (fieldRun) await fieldRun.publish(message)
    else delivered = await this.deliverRoom(room, message)
    const wantsOrchestrator =
      (Array.isArray(resolvedTo) &&
        resolvedTo.some((target) => target.toLowerCase() === ROOM_LABELS.orchestrator.toLowerCase())) ||
      message.mentions.some((target) => target.toLowerCase() === ROOM_LABELS.orchestrator.toLowerCase())
    if (!fieldRun && (message.authorRole === "user" || wantsOrchestrator) && message.author !== ROOM_LABELS.orchestrator) {
      // A live field owns its coordinator channel and batches room updates there.
      // Without a field, a direct user message still has to reach the main session.
      await this.deps.runtime.prompt(parentSessionID, this.coordinatorEnvelope(room, message), {
        delivery: "steer",
        resume: true,
      }).catch(() => undefined)
    }
    await this.saveRoom(room)
    return {
      message,
      delivered,
      room: room.toJSON(),
      text: `Posted ${message.id} as ${message.author}${delivered > 0 ? `, delivered to ${delivered} live agent(s)` : ""}.`,
    }
  }

  private async stopRoomTargets(
    room: ArenaRoom,
    input: { author: string; authorRole: RoomRole; text: string; to?: string[] | "all"; private: boolean; runID?: string },
  ): Promise<RoomChatResult | string> {
    if (input.authorRole !== "user") return "Only the User can force an agent to leave."
    const wanted = typeof input.to === "string" ? (input.to === "all" ? undefined : [input.to]) : input.to
    const targets = room
      .list()
      .filter((participant) => participant.role === "agent" && participant.sessionID)
      .filter(
        (participant) =>
          !wanted || wanted.some((label) => label === "all" || label.toUpperCase() === participant.label.toUpperCase()),
      )
    if (targets.length === 0) return "No bound agent matches that stop."
    const message = room.post({
      author: input.author,
      authorRole: input.authorRole,
      kind: "order",
      text: input.text,
      to: wanted ?? "all",
      order: true,
      private: input.private,
      runID: input.runID,
    })
    let delivered = 0
    for (const participant of targets) {
      const sessionID = participant.sessionID
      if (!sessionID) continue
      const live = !["done", "stopped", "failed"].includes(participant.status)
      if (live) {
        try {
          await this.promptField(
            sessionID,
            `[arena.room ${room.id}] STOP from ${message.author}: ${input.text}\nStop the current work at the next safe point and report what you have. Do not start a new task.`,
            { delivery: "steer" },
          )
          delivered++
          const timer = setTimeout(() => {
            void this.deps.runtime.interrupt(sessionID).catch(() => undefined)
          }, 8000)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        } catch {
          // The participant is stopped even when its session is already gone.
        }
      }
      room.setStatus(participant.label, "stopped")
    }
    await this.saveRoom(room)
    const labels = targets.map((participant) => participant.label).join(", ")
    return { message, delivered, room: room.toJSON(), text: `Stopped ${labels}. The room stays open.` }
  }

  async readRoom(input: {
    parentSessionID?: string
    runID?: string
    label?: string
    after?: string
    sessionID?: string
  }): Promise<string> {
    let parentSessionID = input.parentSessionID
    if (input.runID) {
      const raw = await this.deps.storage.get(`arena:field/${input.runID}`).catch(() => undefined)
      if (typeof raw !== "string") return `No field ${input.runID}.`
      try {
        parentSessionID = readStored<FieldState>(raw)?.parentSessionID
      } catch {
        return `Field ${input.runID} is unreadable.`
      }
    }
    if (!parentSessionID) return "read needs a session or run id."
    parentSessionID = await this.rootSession(parentSessionID)
    const room = await this.roomFor(parentSessionID, false)
    if (!room) return "No arena room for this session yet."
    let label = input.label
    if (!label && input.sessionID) label = this.fieldSessions.get(input.sessionID)?.label ?? this.bindings.get(input.sessionID)?.label
    label = label ?? ROOM_LABELS.orchestrator
    const messages = room.read(label, input.after)
    if (messages.length === 0) return "No messages in this room."
    return messages
      .map((message) => {
        const privateLabel = message.private ? ` private:${message.to === "all" ? "all" : message.to.join(",")}` : ""
        const order = message.order ? " ORDER" : ""
        return `#${message.id} [${message.kind}${order}${privateLabel}] ${message.author}: ${message.text}`
      })
      .join("\n")
  }

  async consumeRoom(input: {
    parentSessionID?: string
    runID?: string
    label: string
    ids: string[]
    keep: boolean
    sessionID?: string
  }): Promise<string> {
    let parentSessionID = input.parentSessionID
    if (input.runID) {
      const raw = await this.deps.storage.get(`arena:field/${input.runID}`).catch(() => undefined)
      if (typeof raw !== "string") return `No field ${input.runID}.`
      try {
        parentSessionID = readStored<FieldState>(raw)?.parentSessionID
      } catch {
        return `Field ${input.runID} is unreadable.`
      }
    }
    if (!parentSessionID) return "consume needs a session or run id."
    parentSessionID = await this.rootSession(parentSessionID)
    const room = await this.roomFor(parentSessionID, false)
    if (!room) return "No arena room for this session yet."
    const label = this.fieldSessions.get(input.sessionID ?? "")?.label ?? this.bindings.get(input.sessionID ?? "")?.label ?? input.label
    const touched = room.consume(label, input.ids, input.keep)
    await this.saveRoom(room)
    return `${input.keep ? "Kept" : "Dropped"} ${touched.length > 0 ? touched.join(", ") : "no valid ids"} for ${label}.`
  }

  async haltRoom(input: {
    parentSessionID?: string
    runID?: string
    author?: string
    reason: string
    text?: string
    to?: string[] | "all"
  }): Promise<string> {
    let parentSessionID = input.parentSessionID
    if (input.runID) {
      const raw = await this.deps.storage.get(`arena:field/${input.runID}`).catch(() => undefined)
      if (typeof raw !== "string") return `No field ${input.runID}.`
      try {
        parentSessionID = readStored<FieldState>(raw)?.parentSessionID
      } catch {
        return `Field ${input.runID} is unreadable.`
      }
    }
    if (!parentSessionID) return "halt needs a session or run id."
    if (input.author !== ROOM_LABELS.user) {
      return "Only the User can stop a field or force an agent to leave."
    }
    parentSessionID = await this.rootSession(parentSessionID)
    const activeField = await this.activeFieldRun(parentSessionID)
    if (activeField) return (await this.stopField(parentSessionID)) ?? `Field ${activeField} stopped.`
    const room = await this.roomFor(parentSessionID)
    if (!room) return "No room for this session."
    room.clearTyping()
    const message = room.post({
      author: input.author ?? ROOM_LABELS.user,
      authorRole: input.author === ROOM_LABELS.orchestrator ? "orchestrator" : "user",
      kind: "order",
      text: input.text ?? `STOP: ${input.reason}`,
      to: input.to ?? "all",
      order: true,
      runID: input.runID,
    })
    const stopped: string[] = []
    for (const participant of room.list()) {
      if (!participant.sessionID) continue
      if (["done", "stopped", "failed"].includes(participant.status)) continue
      try {
        await this.promptField(
          participant.sessionID,
          `[arena.room ${room.id}] STOP from ${message.author}: ${input.reason}\nStop the current work at the next safe point and report what you have. Do not start a new task.`,
          { delivery: "steer" },
        )
        room.setStatus(participant.label, "stopped")
        stopped.push(participant.label)
        const timer = setTimeout(() => {
          void this.deps.runtime.interrupt(participant.sessionID as string).catch(() => undefined)
        }, 8000)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      } catch {
        room.setStatus(participant.label, "stopped")
      }
    }
    const current = room.toJSON().goal
    room.setGoal({
      text: current?.text ?? input.reason,
      by: current?.by ?? message.author,
      status: "stopped",
      at: Date.now(),
      evidence: current?.evidence,
    })
    room.close()
    await this.saveRoom(room)
    await this.deps.synthetic(parentSessionID, `Arena room ${room.id} stopped: ${input.reason}`).catch(() => undefined)
    return `Stop broadcast to ${stopped.length} agent(s)${stopped.length > 0 ? `: ${stopped.join(", ")}` : ""}. The transcript remains.`
  }

  async finishParticipant(input: {
    sessionID?: string
    runID?: string
    parentSessionID?: string
    label?: string
    summary?: string
    goal?: string
  }): Promise<string> {
    if (!input.sessionID) return "finish needs a bound field session."
    if (isSealed(input.sessionID)) return "This agent is sealed; no message can reach it again."
    const fieldBinding = this.fieldSessions.get(input.sessionID)
    const run = fieldBinding ? this.fields.get(fieldBinding.runID) : undefined
    if (!fieldBinding || !run) return "finish needs a bound field session."
    const text = input.summary?.trim() || input.goal?.trim() || "I believe the goal is met."
    const evidence = input.goal?.trim() ? [input.goal.trim()] : []
    await run.notePost({ author: fieldBinding.label, kind: "claim", text, evidence })
    return `${fieldBinding.label} posted a claim; the gate is checking it (the result appears in the room).`
  }

  async leaveParticipant(sessionID: string, reason: string): Promise<string> {
    const binding = this.fieldSessions.get(sessionID)
    const run = binding ? this.fields.get(binding.runID) : undefined
    if (!binding || !run) return "leave needs a live field session."
    if (sealOf(sessionID)?.reason === "left") return `${binding.label} already left.`
    const result = await run.leave({ label: binding.label, by: "self", reason })
    return result.ok
      ? `${binding.label} left the field. This session is sealed permanently.`
      : `Arena: ${result.error ?? "could not leave"}`
  }

  /** Only the real User path may call this. */
  async forceLeave(parentSessionID: string, label: string, reason: string): Promise<string> {
    parentSessionID = await this.rootSession(parentSessionID)
    const fieldID = await this.activeFieldRun(parentSessionID).catch(() => undefined)
    const run = fieldID ? this.fields.get(fieldID) : undefined
    if (!run) return "No live field to remove an agent from."
    const found = run.snapshot.members.find((member) => member.label.toLowerCase() === label.toLowerCase())
    if (!found) return `No agent named ${label} in this field.`
    const result = await run.leave({ label: found.label, by: "user", reason })
    return result.ok ? `${label} was removed by the User and is permanently sealed.` : `Arena: ${result.error ?? "could not leave"}`
  }

  async updateParticipant(input: {
    parentSessionID?: string
    runID?: string
    label: string
    task?: string
    agent?: string
    model?: string
    author?: string
  }): Promise<string> {
    let parentSessionID = input.parentSessionID
    if (input.runID) {
      const raw = await this.deps.storage.get(`arena:field/${input.runID}`).catch(() => undefined)
      if (typeof raw !== "string") return `No field ${input.runID}.`
      try {
        parentSessionID = readStored<FieldState>(raw)?.parentSessionID
      } catch {
        return `Field ${input.runID} is unreadable.`
      }
    }
    if (!parentSessionID) return "update needs a session or run id."
    const room = await this.roomFor(parentSessionID, false)
    if (!room) return "No arena room for this session yet."
    const participant = room.participant(input.label)
    if (!participant) return `No participant ${input.label}.`
    if (participant.status === "left") return `${participant.label} left the field and cannot be reassigned.`
    const notes: string[] = []
    if (input.agent && participant.sessionID && this.deps.runtime.switchAgent) {
      await this.deps.runtime.switchAgent(participant.sessionID, input.agent).catch((error: unknown) => {
        notes.push(`agent switch failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      participant.agent = input.agent
      notes.push(`agent set to ${input.agent}`)
    }
    if (input.model && participant.sessionID && this.deps.runtime.switchModel) {
      const model = parseModel(input.model)
      if (model) {
        await this.deps.runtime.switchModel(participant.sessionID, model).catch((error: unknown) => {
          notes.push(`model switch failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        participant.model = input.model
        notes.push(`model set to ${input.model}`)
      }
    }
    if (input.task) {
      const activeID = await this.activeFieldRun(parentSessionID).catch(() => undefined)
      const active = activeID ? this.fields.get(activeID) : undefined
      if (active?.snapshot.sameRole) {
        return "This is an independent same-role room. Seats own their work; post a dead-end, a fact, or a direct ask instead of assigning a task."
      }
      const author = input.author ?? ROOM_LABELS.orchestrator
      const message = room.post({
        author,
        authorRole: author === ROOM_LABELS.orchestrator ? "orchestrator" : "user",
        kind: "order",
        text: `New task for ${participant.label}: ${input.task}`,
        to: [participant.label],
        private: true,
        order: true,
        runID: input.runID,
      })
      if (participant.sessionID) {
        await this.promptField(
          participant.sessionID,
          `[arena.room ${room.id}] New task from ${author}: ${input.task}\nStop the old task at the next safe point and work on this one. Reply in the room.`,
          { delivery: "steer", resume: true },
        ).catch(() => undefined)
      }
      void message
      notes.push("task sent")
    }
    room.addParticipant({ label: participant.label, agent: participant.agent, model: participant.model })
    await this.saveRoom(room)
    return `Updated ${participant.label}: ${notes.length > 0 ? notes.join("; ") : "no change"}.`
  }

  async spawnSubagent(
    input: { agent: string; prompt: string; model?: string; timeoutMs?: number },
    callerSessionID: string,
  ): Promise<SpawnResult> {
    if (isSealed(callerSessionID)) return { ok: false, text: "This agent is sealed and cannot start new work." }
    const binding = this.bindings.get(callerSessionID)
    const depth = binding?.depth ?? 0
    const maxDepth = 3
    if (depth >= maxDepth) return { ok: false, text: `Subagent depth limit reached (${maxDepth}). Answer the question yourself.` }
    const agents = await this.deps.runtime.listAgents().catch(() => [])
    if (agents.length > 0 && !agents.some((agent) => agent.id === input.agent)) {
      return { ok: false, text: `Unknown agent "${input.agent}". Available: ${agents.map((agent) => agent.id).join(", ")}` }
    }
    const model = input.model ? parseModel(input.model) : undefined
    const fieldCaller = Boolean(this.fieldSessions.get(callerSessionID))
    const fieldRun = fieldCaller ? this.fields.get(this.fieldSessions.get(callerSessionID)!.runID) : undefined
    const fieldPolicy = fieldRun?.snapshot.toolPolicy ?? "arena"
    const permissions = permissionRules(
      true,
      fieldCaller ? fieldPolicy === "all" : true,
      fieldCaller && fieldPolicy !== "all",
    )
    let sessionID: string
    try {
      sessionID = await this.deps.runtime.createSession({
        title: `arena ${binding?.runID ?? "solo"} ${binding?.label ?? "main"} subagent ${input.agent}`,
        agent: input.agent,
        parentID: callerSessionID,
        model,
        metadata: {
          arenaRun: binding?.runID ?? "solo",
          arenaRole: "subagent",
          arenaLabel: binding?.label ?? "main",
          arenaDepth: depth + 1,
        },
        permissions,
      })
    } catch (error) {
      return { ok: false, text: `Subagent could not start: ${error instanceof Error ? error.message : String(error)}` }
    }
    this.bindings.set(sessionID, {
      runID: binding?.runID ?? "solo",
      label: binding?.label ?? "main",
      role: "subagent",
      depth: depth + 1,
    })
    const contract = (binding ? this.fields.get(binding.runID)?.snapshot.contract : undefined) ?? {
      objective: "Answer the parent's question.",
      constraints: [],
      successCriteria: [],
      nonGoals: [],
    }
    const prompt = helperPrompt({ contract, parent: binding?.label ?? "main", question: input.prompt, depth: depth + 1 })
    const timeoutMs = Math.min(900_000, Math.max(30_000, input.timeoutMs ?? 300_000))
    let text = ""
    try {
      await this.deps.runtime.prompt(sessionID, prompt)
      const outcome = await this.deps.runtime.wait(sessionID, timeoutMs)
      if (outcome === "timeout") {
        await this.deps.runtime.interrupt(sessionID).catch(() => undefined)
        return { ok: false, text: `Subagent timed out after ${Math.round(timeoutMs / 1000)}s.`, sessionID }
      }
      if (outcome === "error") return { ok: false, text: "Subagent execution failed.", sessionID }
      text = await this.deps.runtime.finalText(sessionID)
    } finally {
      const usage = await this.deps.runtime.usage(sessionID).catch(() => ({ costUSD: 0, tokens: 0 }))
      void usage
    }
    return { ok: text.length > 0, text: text || "The subagent returned no text.", sessionID }
  }

  isFieldMember(sessionID: string): boolean {
    return this.fieldSessions.has(sessionID)
  }

  guardTool(sessionID: string, tool: string, input: unknown): { allowed: boolean; reason?: string } {
    const binding = this.fieldSessions.get(sessionID)
    if (!binding) return { allowed: true }
    const run = this.fields.get(binding.runID)
    if (!run) return { allowed: true }
    const name = tool.toLowerCase()
    const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
    // Some hosts expose plugin tools only inside Code Mode's `execute`. A field
    // seat must still reach the Arena tools there, but nothing else: an
    // `execute` that calls only Arena tools is the same request as calling them
    // directly, and both go through the Arena's lock and copy-on-write rules.
    if (base === "execute" && arenaOnlyCode(input)) return { allowed: true }
    if (run.snapshot.toolPolicy === "all") {
      // Full capability profile: host shell/write/edit, MCP tools, browser,
      // skills, task/subagent and UI helpers are intentionally available. No
      // host, URL, scope or network check runs on this path.
      return { allowed: true }
    }
    // A field seat is an allowlist, not a denylist. `read`/`grep`/`glob` are
    // context tools; the Arena tools do the work. Browser, webfetch, websearch,
    // skills, task/subagent and UI helpers must not become a side door around
    // the copy-on-write tree and the launch lease.
    const fieldTools = new Set([
      "arena",
      "arena_bus",
      "arena_fs",
      "arena_git",
      "arena_exec",
      "arena_job",
      "arena_spawn",
      "read",
      "grep",
      "glob",
      "webfetch",
      "websearch",
      "skill",
      "question",
      "ask_user_question",
    ])
    if (!fieldTools.has(base)) {
      return {
        allowed: false,
        reason: `Field seats may use arena_fs/arena_git/arena_exec/arena_job, arena_bus, read/grep/glob, webfetch/websearch, skill and question; ${tool} is not part of the Arena field surface.`,
      }
    }
    // The Arena owns mutation and launch. A field agent may still read/grep for
    // context, but writes, edits, patches and direct shells go through arena_fs
    // or arena_exec so the run lock and copy-on-write are enforced.
    if (
      ["shell", "bash", "write", "edit", "patch", "apply", "task", "subagent", "spawn", "execute"].includes(base)
    ) {
      return {
        allowed: false,
        reason: `Use arena_fs (read/write/list/copy) and arena_exec/arena_job instead of ${tool}. Arena owns the workspace lock and process handles.`,
      }
    }
    return run.guardTool(sessionID, tool, input)
  }

  private fieldWork(sessionID: string): FieldWork | undefined {
    const binding = this.fieldSessions.get(sessionID)
    if (!binding) return undefined
    const run = this.fields.get(binding.runID)
    if (!run) return undefined
    const member = run.snapshot.members.find((entry) => entry.label === binding.label)
    if (!member) return undefined
    const sharedRoot = run.snapshot.workspaceRoot ?? this.deps.root
    return {
      binding,
      run,
      cwd: member.workspacePath ?? sharedRoot,
      sharedRoot,
      copyOnWrite: run.snapshot.copyOnWrite === true,
      workspace: this.fieldWorkspaces.get(binding.runID)?.get(binding.label),
    }
  }

  private within(base: string, target: string): boolean {
    const rel = relative(base, target)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  private resolveFsPath(work: { cwd: string; sharedRoot: string }, path: string, writable: boolean): string {
    const target = isAbsolute(path) ? resolve(path) : resolve(work.cwd, path)
    if (writable) {
      if (!this.within(work.cwd, target)) throw new Error(`path is outside your writable workspace: ${path}`)
      return target
    }
    const arenaRoot = join(tmpdir(), "arena")
    if (
      !this.within(work.cwd, target) &&
      !this.within(work.sharedRoot, target) &&
      !this.within(arenaRoot, target)
    ) {
      throw new Error(`path is outside the Arena workspace: ${path}`)
    }
    return target
  }

  async arenaFs(
    sessionID: string,
    input: {
      action: string
      path?: string
      content?: string
      encoding?: "utf8" | "base64"
      to?: string
      from?: string
    },
  ): Promise<string> {
    const work = this.fieldWork(sessionID)
    if (!work) return "arena_fs needs a live field session."
    const action = input.action
    const path = input.path?.trim() ?? ""
    if (!path && action !== "status" && action !== "diff" && action !== "merge") {
      return "arena_fs needs a path."
    }
    // A copy-on-write tree is private. Two seats writing their own files cannot
    // collide, so the single run lock would only serialize independent work.
    const locked = <T>(fn: () => Promise<T>, resource?: string): Promise<T> =>
      work.copyOnWrite
        ? fn()
        : withRunLock(
            resource ? resourceLockKey(work.binding.runID, `fs:${resource}`) : work.binding.runID,
            fn,
          )
    try {
      if (action === "read") {
        const target = this.resolveFsPath(work, path, false)
        const data = await readFile(target)
        if (input.encoding === "base64") {
          return data.byteLength > 200_000 ? `${data.subarray(0, 200_000).toString("base64")}\n[truncated]` : data.toString("base64")
        }
        const text = data.toString("utf8")
        return text.length > 200_000 ? `${text.slice(0, 200_000)}\n[truncated]` : text
      }
      if (action === "list") {
        const target = this.resolveFsPath(work, path, false)
        const entries = await readdir(target, { withFileTypes: true })
        return entries
          .slice(0, 500)
          .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
          .join("\n")
      }
      if (action === "stat") {
        const target = this.resolveFsPath(work, path, false)
        const info = await stat(target)
        return `${info.isDirectory() ? "directory" : "file"} ${info.size} bytes ${info.mtime.toISOString()}`
      }
      if (action === "merge") {
        const from = input.from?.trim()
        if (!from) return "arena_fs merge needs from=<agent name>."
        const source = this.fieldWorkspaces.get(work.binding.runID)?.get(from)
        if (!source || !work.workspace || !this.deps.workspace.merge) {
          return `No separate workspace for ${from}; merge needs copy-on-write.`
        }
        return locked(async () => {
          const result = await this.deps.workspace!.merge!(work.workspace!, source)
          return `${result.output}${result.conflicts.length > 0 ? `\nResolve conflict markers in: ${result.conflicts.join(", ")}` : ""}`
        })
      }
      if (action === "status") {
        if (!work.workspace) return "No embedded baseline for this workspace; shared mode has no per-agent diff."
        const changed = await this.deps.workspace.changedFiles(work.workspace)
        return changed.length > 0 ? changed.join("\n") : "clean since baseline"
      }
      if (action === "diff") {
        if (!work.workspace) return "No embedded baseline for this workspace; shared mode has no per-agent diff."
        return (await this.deps.workspace.diff(work.workspace, 20_000)) || "no changes since baseline"
      }
      if (action === "write") {
        const target = this.resolveFsPath(work, path, true)
        return locked(async () => {
          await mkdir(dirname(target), { recursive: true })
          const bytes = Buffer.from(input.content ?? "", input.encoding === "base64" ? "base64" : "utf8")
          await writeFile(target, bytes)
          return `wrote ${path} (${bytes.byteLength} bytes) in ${work.cwd}`
        }, path)
      }
      if (action === "copy") {
        const to = input.to?.trim()
        if (!to) return "arena_fs copy needs to."
        const from = this.resolveFsPath(work, path, false)
        const target = this.resolveFsPath(work, to, true)
        return locked(async () => {
          await mkdir(dirname(target), { recursive: true })
          await copyFile(from, target)
          return `copied ${path} -> ${to}`
        }, to)
      }
      if (action === "remove") {
        const target = this.resolveFsPath(work, path, true)
        return locked(async () => {
          await rm(target, { recursive: true, force: true })
          return `removed ${path}`
        }, path)
      }
      return "arena_fs action must be read, list, stat, write, copy or remove."
    } catch (error) {
      return `arena_fs: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Branch-level git for a copy-on-write seat. It is deliberately not a raw
   * `git` shell: status, diff, log, commit, merge, abort and conflict resolution
   * all go through the same workspace and the same merge lock.
   */
  async arenaGit(
    sessionID: string,
    input: {
      action: string
      message?: string
      from?: string
      paths?: string[]
      take?: "ours" | "theirs"
      limit?: number
    },
  ): Promise<string> {
    const work = this.fieldWork(sessionID)
    if (!work) return "arena_git needs a live field session."
    if (!work.copyOnWrite || !work.workspace?.isolated) {
      return "arena_git needs copy-on-write; a shared tree has no seat branch to merge."
    }
    const workspace = work.workspace
    const action = input.action
    try {
      if (action === "status") {
        const changed = await this.deps.workspace.changedFiles(workspace)
        return `branch ${workspace.branch ?? "(detached)"} at ${workspace.path}\n${changed.length > 0 ? changed.join("\n") : "clean since baseline"}`
      }
      if (action === "diff") {
        return (await this.deps.workspace.diff(workspace, 20_000)) || "no changes since baseline"
      }
      if (action === "log") {
        if (!this.deps.workspace.log) return "git log is not available on this host."
        return await this.deps.workspace.log(workspace, input.limit ?? 10)
      }
      if (action === "commit") {
        if (!this.deps.workspace.commit) return "git commit is not available on this host."
        const message = input.message?.trim()
        if (!message) return "arena_git commit needs a message."
        const result = await this.deps.workspace.commit(workspace, message)
        return `${result.output}\nHEAD ${result.hash || "(no commit)"}`
      }
      if (action === "merge") {
        const from = input.from?.trim()
        if (!from) return "arena_git merge needs from=<agent name>."
        if (!this.deps.workspace.mergeBranch) return "branch merge is not available on this host."
        const source = this.fieldWorkspaces.get(work.binding.runID)?.get(from)
        if (!source?.isolated || !source.branch) return `No separate branch for ${from}.`
        if (source.branch === workspace.branch) return `${from} is already on your branch.`
        return await withRunLock(work.binding.runID, async () => {
          const merged = await this.deps.workspace.mergeBranch!(workspace, source.branch!, input.message ?? `merge ${from}`)
          if (!merged.ok) {
            return `${merged.output}\nResolve the conflicts with arena_git resolve --take ours|theirs --paths <files>, then commit; or arena_git abort.`
          }
          const command = work.run.snapshot.contract.verificationCommand
          if (command) {
            const verification = await this.deps.workspace.verify(
              workspace,
              command,
              work.binding.label,
              600_000,
            )
            if (!verification.passed) {
              await this.deps.workspace.abortMerge?.(workspace)
              return `merge verification failed (exit ${verification.exitCode}); merge aborted.\n${verification.output}`
            }
          }
          const committed = await this.deps.workspace.commit!(workspace, input.message ?? `merge ${from}`)
          return `${merged.output}\n${committed.output}\nmerge HEAD ${committed.hash}`
        }, 30_000, 5 * 60_000)
      }
      if (action === "abort") {
        if (!this.deps.workspace.abortMerge) return "merge abort is not available on this host."
        return await this.deps.workspace.abortMerge(workspace)
      }
      if (action === "resolve") {
        if (!this.deps.workspace.resolve) return "merge resolution is not available on this host."
        const paths = (input.paths ?? []).map((path) => path.trim()).filter(Boolean)
        if (paths.length === 0) return "arena_git resolve needs paths."
        const take = input.take === "theirs" ? "theirs" : "ours"
        return await this.deps.workspace.resolve(workspace, paths, take)
      }
      return "arena_git action must be status, diff, log, commit, merge, abort or resolve."
    } catch (error) {
      return `arena_git: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private spawnJob(work: FieldWork, command: string, cwd: string, foreground: boolean): ArenaJob {
    const id = `job_${Date.now().toString(36)}_${++this.jobSeq}`
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    const job: ArenaJob = {
      id,
      runID: work.binding.runID,
      label: work.binding.label,
      command,
      cwd,
      status: "running",
      pid: child.pid,
      startedAt: Date.now(),
      foreground,
      output: "",
    }
    const append = (chunk: Buffer | string) => {
      job.output = `${job.output}${String(chunk)}`.slice(-30_000)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", (error) => {
      job.status = "failed"
      job.endedAt = Date.now()
      job.output = `${job.output}\n${error.message}`.slice(-30_000)
    })
    child.on("close", (code) => {
      if (job.status === "running") job.status = code === 0 ? "exited" : "failed"
      job.exitCode = code ?? undefined
      job.endedAt = Date.now()
      void work.run.releaseLaunch(work.binding.label, job.id).catch(() => undefined)
    })
    job.child = child
    this.jobs.set(id, job)
    return job
  }

  async arenaExec(
    sessionID: string,
    input: { command?: string; cwd?: string; timeoutMs?: number; background?: boolean; resource?: string },
  ): Promise<string> {
    const work = this.fieldWork(sessionID)
    if (!work) return "arena_exec needs a live field session."
    const command = input.command?.trim()
    if (!command) return "arena_exec needs a command."
    if (work.copyOnWrite && command.toLowerCase().includes(work.sharedRoot.toLowerCase())) {
      return "arena_exec must run in your copy. Use arena_fs copy to bring a file in, or post the path in the room instead of writing the shared baseline."
    }
    const verdict = work.run.guardTool(sessionID, "arena_exec", { command })
    if (!verdict.allowed) return `arena_exec: ${verdict.reason ?? "another seat owns this launch"}`
    const cwd = input.cwd ? this.resolveFsPath(work, input.cwd, true) : work.cwd
    if (input.background) {
      if (!work.copyOnWrite) return "Background jobs need copy-on-write so they cannot mutate the shared baseline."
      const job = this.spawnJob(work, command, cwd, false)
      await work.run.attachLaunch(work.binding.label, job.id, job.pid).catch(() => undefined)
      return `Job ${job.id} started in ${cwd}. Use arena_job action=status or stop with jobID=${job.id}.`
    }
    // A foreground command owns the run lock. Keep that hold short: anything
    // that needs longer is a background job, so one GUI/debugger cannot freeze
    // every other seat for the rest of the field.
    const timeoutMs = Math.min(120_000, Math.max(1_000, input.timeoutMs ?? 60_000))
    const run = async (): Promise<string> => {
      const job = this.spawnJob(work, command, cwd, true)
      const child = job.child
      if (!child) return `arena_exec: could not start ${job.id}`
      await work.run.attachLaunch(work.binding.label, job.id, job.pid).catch(() => undefined)
      if (job.status !== "running") {
        await work.run.releaseLaunch(work.binding.label, job.id).catch(() => undefined)
      }
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void killProcessTree(job.pid)
      }, timeoutMs)
      // `exit` fires even when a grandchild keeps stdout/stderr open; `close`
      // alone would wait forever and hold the lock.
      let guard: ReturnType<typeof setTimeout> | undefined
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          if (guard) clearTimeout(guard)
          resolve()
        }
        child.once("exit", finish)
        child.once("close", finish)
        child.once("error", finish)
        // If taskkill needs a moment, do not keep the run lock for the whole
        // process tree's shutdown.
        guard = setTimeout(finish, timeoutMs + 5_000)
      })
      clearTimeout(timer)
      await work.run.releaseLaunch(work.binding.label, job.id).catch(() => undefined)
      if (timedOut) {
        job.status = "failed"
        job.endedAt = Date.now()
        job.output = `${job.output}\n[arena_exec timed out after ${timeoutMs}ms; process tree terminated]`.slice(-30_000)
        return `${job.output || "(no output)"}\n[exit timeout]`
      }
      return `${job.output || "(no output)"}\n[exit ${job.exitCode ?? "unknown"}]`
    }
    // In a private worktree the only shared resource is the host process, and
    // the launch lease already serializes that. In a shared tree, a caller can
    // name one resource and lock only that resource instead of the whole crew.
    const resource = input.resource?.trim()
    const key = resource ? resourceLockKey(work.binding.runID, `exec:${resource}`) : work.binding.runID
    return work.copyOnWrite ? run() : withRunLock(key, run, 30_000, 5 * 60_000)
  }

  arenaJob(sessionID: string, input: { action?: string; jobID?: string }): string {
    const work = this.fieldWork(sessionID)
    if (!work) return "arena_job needs a live field session."
    const action = input.action ?? "list"
    if (action === "list") {
      const rows = [...this.jobs.values()]
        .filter((job) => job.runID === work.binding.runID)
        .map((job) => `${job.id} ${job.status} ${job.label} pid=${job.pid ?? "-"} ${job.command.slice(0, 80)}`)
      return rows.length > 0 ? rows.join("\n") : "No Arena jobs in this run."
    }
    const job = input.jobID ? this.jobs.get(input.jobID) : undefined
    if (!job) return "No such Arena job."
    if (action === "status") return `${job.id} ${job.status} pid=${job.pid ?? "-"} exit=${job.exitCode ?? "-"} ${job.command}`
    if (action === "output") return job.output || "(no output)"
    if (action === "stop") {
      if (job.status === "running") {
        void killProcessTree(job.pid)
        job.status = "stopped"
        job.endedAt = Date.now()
      }
      void work.run.releaseLaunch(job.label, job.id).catch(() => undefined)
      return `${job.id} ${job.status}`
    }
    return "arena_job action must be list, status, output or stop."
  }

  private stopJobs(runID: string, labels?: string[]): void {
    for (const job of this.jobs.values()) {
      if (job.runID !== runID) continue
      if (labels && !labels.includes(job.label)) continue
      if (job.status === "running") {
        void killProcessTree(job.pid)
        job.status = "stopped"
        job.endedAt = Date.now()
      }
      void this.fields.get(job.runID)?.releaseLaunch(job.label, job.id).catch(() => undefined)
    }
  }

  markClosing(sessionID: string, ttlMs = 5 * 60_000): void {
    this.closingParents.set(sessionID, Date.now() + ttlMs)
  }

  isFieldParent(sessionID: string): boolean {
    for (const run of this.fields.values()) {
      if (run.snapshot.parentSessionID !== sessionID) continue
      if (["running", "paused", "stopping"].includes(run.snapshot.status)) return true
    }
    const until = this.closingParents.get(sessionID)
    if (!until) return false
    if (until <= Date.now()) {
      this.closingParents.delete(sessionID)
      return false
    }
    return true
  }

  statusLineFor(sessionID: string): string | undefined {
    for (const run of this.fields.values()) {
      if (run.snapshot.parentSessionID !== sessionID) continue
      const state = run.snapshot
      const working = state.members.filter((member) => member.status === "working").length
      const left = state.members.filter((member) => member.status === "left").length
      return `arena ${state.id} | field | ${state.status} | ${state.members.length} agents | ${working} working | ${left} left | ${state.posts} posts, ${state.deadEnds} dead ends\nYou are the coordinator, not a worker. Do not investigate or run debuggers while this field is live. Use arena status/read to inspect the room and arena chat or steer to guide the crew. Only the User can stop the field or force an agent to leave; you cannot. Answer the User, and stop when asked.`
    }
    return undefined
  }

  roomContextFor(sessionID: string): { room: ArenaRoom; label: string; block: string } | undefined {
    if (this.fieldSessions.has(sessionID)) return undefined
    // A live field already sends its coordinator the state card. Another room
    // digest would duplicate it and wake the coordinator for commentary.
    const parentOfLiveField = [...this.fields.values()].some(
      (run) => run.snapshot.parentSessionID === sessionID && run.snapshot.status === "running",
    )
    if (parentOfLiveField) return undefined
    const direct = this.rooms.get(sessionID)
    if (direct) {
      const block = this.roomDigest(direct, ROOM_LABELS.orchestrator)
      return block ? { room: direct, label: ROOM_LABELS.orchestrator, block } : undefined
    }
    for (const room of this.rooms.values()) {
      const participant = room.participantBySession(sessionID)
      if (!participant) continue
      const block = this.roomDigest(room, participant.label)
      return block ? { room, label: participant.label, block } : undefined
    }
    return undefined
  }

  async busPost(
    sessionID: string,
    kind: string,
    text: string,
    to?: string,
    runID?: string,
    label?: string,
    replyTo?: string,
    evidence?: string[],
    replyInSeconds?: number,
    area?: string,
    leaseMinutes?: number,
    leaseKind?: string,
    paths?: string[],
    basedOn?: string[],
    contradicts?: string[],
    command?: string,
    expect?: string,
    killIf?: string,
    preflight?: string,
    baseline?: string,
    experiment?: string,
    result?: "pass" | "fail" | "invalid",
    observed?: string,
    pidBefore?: string,
    pidAfter?: string,
    oracleKind?: "ui" | "file" | "http" | "process" | "registry" | "command",
    baselineAt?: number,
    scope?: string,
    writer?: string,
    coverage?: string[],
  ): Promise<string> {
    const seal = sealOf(sessionID)
    if (seal) {
      return seal.reason === "left"
        ? `${seal.label} left the field and is permanently sealed.`
        : `${seal.label} is sealed (${seal.reason}); no message can reach it.`
    }
    const fieldBinding = this.fieldSessions.get(sessionID)
    const fieldRun = fieldBinding ? this.fields.get(fieldBinding.runID) : undefined
    if (fieldBinding && fieldRun && fieldRun.snapshot.status === "done") {
      return `Field ${fieldBinding.runID} is closed. This agent cannot post; start a new field.`
    }
    if (fieldBinding && fieldRun) {
      const author = fieldBinding.label || label || "delegate"
      const target = to && to.length > 0 ? (to === "all" ? "all" : [to]) : "all"
      const posted = await fieldRun.notePost({
        author,
        kind: fieldKindOf(kind),
        text,
        to: target,
        evidence,
        coverage,
        replyTo,
        replyInSeconds,
        area,
        leaseMinutes,
        leaseKind,
        paths,
        basedOn,
        contradicts,
        command,
        expect,
        killIf,
        preflight,
        baseline,
        experiment,
        result,
        observed,
        pidBefore,
        pidAfter,
        oracleKind,
        baselineAt,
        scope,
        writer,
      })
      if (posted.error) return `Arena: ${posted.error}`
      return `Posted ${posted.id} as ${author} to ${target === "all" ? "the room" : target.join(", ")}.`
    }
    const binding = this.bindings.get(sessionID)
    const room = await this.roomFor(binding?.runID ? (await this.fieldParent(binding.runID)) ?? "" : "", false).catch(() => undefined)
    if (binding && room) {
      const message = room.post({
        author: binding.label,
        authorRole: "agent",
        kind: (kind === "note" ? "chat" : kind) as RoomKind,
        text,
        to: to && to.length > 0 ? (to === "all" ? "all" : [to]) : "all",
        runID: binding.runID,
        replyTo,
      })
      await this.saveRoom(room)
      return `Posted ${message.id} as ${binding.label} to the room.`
    }
    return "No field is attached to this session. Use arena_bus post from a field session, or arena chat from the main session."
  }

  async resolveArbitration(sessionID: string, id: string, result: string): Promise<string> {
    const binding = this.fieldSessions.get(sessionID)
    if (!binding) return "No field is attached to this session."
    const run = this.fields.get(binding.runID)
    if (!run) return `Field ${binding.runID} is not live.`
    return run.resolveArbitration(id, result)
  }

  async busRead(sessionID: string, runID?: string, label?: string, after?: string, id?: string): Promise<string> {
    const fieldBinding = this.fieldSessions.get(sessionID)
    const binding = fieldBinding ?? this.bindings.get(sessionID)
    const parent = binding ? (fieldBinding?.parentSessionID ?? (await this.fieldParent(binding.runID))) : undefined
    const room = parent ? await this.roomFor(parent, false) : undefined
    if (room) {
      const who = fieldBinding?.label ?? binding?.label ?? label ?? ROOM_LABELS.orchestrator
      const wanted = id?.trim()
      const messages = wanted
        ? room.all().filter((message) => message.id.toLowerCase() === wanted.toLowerCase())
        : room.read(who, after?.trim() || undefined)
      if (wanted && messages.length === 0) return `No message ${wanted} in this room.`
      const run = fieldBinding ? this.fields.get(fieldBinding.runID) : undefined
      const lines: string[] = []
      const snapshot = run?.snapshot
      if (snapshot?.oracle) {
        lines.push(`Oracle: ${snapshot.oracle.observable}${snapshot.oracle.confirmed ? " (confirmed)" : " (unconfirmed)"}`)
        lines.push(`Baseline: ${snapshot.oracle.baseline}`)
      }
      for (const experiment of snapshot?.experiments ?? []) {
        lines.push(
          `${experiment.id} [${experiment.status}] ${experiment.owner}: ${experiment.hypothesis} -> expect ${experiment.expect}`,
        )
      }
      const facts = snapshot?.facts ?? []
      if (facts.length > 0) {
        lines.push("Truth table:")
        for (const fact of facts.slice(-12)) {
          lines.push(`- ${fact.id} [${fact.status}] ${fact.author}: ${fact.claim}`)
        }
        const arbitrations = (snapshot?.arbitrations ?? []).filter((entry) => entry.status === "open")
        if (arbitrations.length > 0) {
          lines.push("Open arbitration:")
          for (const entry of arbitrations) {
            lines.push(`- ${entry.id} owner=${entry.owner} test=${entry.test}`)
          }
        }
        lines.push("")
      }
      if (messages.length === 0) return lines.length > 0 ? lines.join("\n") : "No messages in the room."
      lines.push(
        ...messages.map((message) => {
          const privateLabel = message.private ? ` private:${message.to === "all" ? "all" : message.to.join(",")}` : ""
          const order = message.order ? " ORDER" : ""
          const body = (message.meta?.detail ?? message.text).slice(0, 1_200)
          return `#${message.id} [${message.kind}${order}${privateLabel}] ${message.author}: ${body}`
        }),
      )
      return lines.join("\n")
    }
    void runID
    return "No field is attached to this session."
  }

  private async fieldParent(runID: string): Promise<string | undefined> {
    const raw = await this.deps.storage.get(`arena:field/${runID}`).catch(() => undefined)
    if (typeof raw !== "string") return undefined
    try {
      return readStored<FieldState>(raw)?.parentSessionID
    } catch {
      return undefined
    }
  }

  async status(runID: string | undefined, parentSessionID?: string): Promise<ArenaStatus> {
    if (parentSessionID) {
      const board = await this.fieldBoard(parentSessionID).catch(() => undefined)
      if (board) return { text: await this.fieldStatus(parentSessionID) }
    }
    if (runID) {
      const parent = await this.fieldParent(runID)
      const raw = await this.deps.storage.get(`arena:field/${runID}`).catch(() => undefined)
      if (typeof raw === "string" && parent) {
        try {
          const state = readStored<FieldState>(raw)
          if (!state) return { text: `Field ${runID}: the saved state is unreadable.` }
          const room = await this.roomFor(parent, false)
          return { text: this.describeBoard(boardOf(state, Date.now()), room?.toJSON().messages.slice(-8)) }
        } catch {
          return { text: `Field ${runID}: the saved state is unreadable.` }
        }
      }
    }
    return { text: "No field run found for this session." }
  }

  async report(runID: string | undefined, parentSessionID?: string): Promise<string> {
    if (parentSessionID) {
      const board = await this.fieldBoard(parentSessionID).catch(() => undefined)
      if (board) {
        const room = await this.roomFor(parentSessionID, false)
        return this.describeBoard(board, room?.toJSON().messages.slice(-8))
      }
    }
    if (runID) {
      const parent = await this.fieldParent(runID)
      const raw = await this.deps.storage.get(`arena:field/${runID}`).catch(() => undefined)
      if (typeof raw === "string" && parent) {
        try {
          const state = readStored<FieldState>(raw)
          if (!state) return `Field ${runID}: the saved state is unreadable.`
          const room = await this.roomFor(parent, false)
          return this.describeBoard(boardOf(state, Date.now()), room?.toJSON().messages.slice(-8))
        } catch {
          return `Field ${runID}: the saved state is unreadable.`
        }
      }
    }
    return "No field run found."
  }

  async list(): Promise<string> {
    if (this.fields.size === 0) return "No active fields."
    return `Active fields:\n${[...this.fields.values()]
      .map((run) => {
        const state = run.snapshot
        return `${state.id} | field | ${state.status} | ${state.members.length} agents | ${state.posts} posts | ${oneLine(state.contract.objective, 120)}`
      })
      .join("\n")}`
  }

  async waitForRoomTick(parentSessionID: string, after: string, timeoutMs: number): Promise<unknown> {
    parentSessionID = await this.rootSession(parentSessionID)
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 30_000)
    while (Date.now() < deadline) {
      const field = await this.fieldBoard(parentSessionID).catch(() => undefined)
      const stamp = field
        ? `${field.roomUpdatedAt ?? 0}:${field.messageCount ?? 0}:${field.status}:${field.stopReason ?? ""}`
        : ""
      if (stamp !== after) return field
      await sleep(120)
    }
    return this.fieldBoard(parentSessionID).catch(() => undefined)
  }

  private roomDigest(room: ArenaRoom, label: string): string {
    const participant = room.participant(label)
    const view: KnowledgeView = { seen: [], kept: participant?.keep ?? [], dropped: participant?.drop ?? [] }
    if (label === ROOM_LABELS.orchestrator) {
      // The coordinator gets the state card from the driver; a long room digest
      // here would duplicate it and wake it for commentary.
      return ""
    }
    const items: KnowledgeItem[] = room.all().map((message) => ({
      id: message.id,
      author: message.author,
      kind: knowledgeKind(message.kind),
      text: message.meta?.detail ?? message.text,
      at: message.at,
      to: message.to,
      private: message.private,
    }))
    return digest(items, view, label, { budget: 2_400, maxItems: 10, lineChars: 260 })
  }

  private async refreshRoom(parentSessionID: string): Promise<ArenaRoom | undefined> {
    const existing = this.rooms.get(parentSessionID)
    const snapshot = await this.loadRoomSnapshot(parentSessionID)
    if (!snapshot) return existing
    if (existing) {
      existing.absorb(snapshot)
      this.indexRoom(existing)
      return existing
    }
    const room = ArenaRoom.from(snapshot)
    this.rooms.set(parentSessionID, room)
    this.indexRoom(room)
    if (!this.roomIDs.has(parentSessionID)) this.roomIDs.add(parentSessionID)
    this.ensureRoomTimer()
    return room
  }

  private indexRoom(room: ArenaRoom): void {
    for (const participant of room.list()) {
      if (participant.sessionID) this.sessionParents.set(participant.sessionID, room.parentSessionID)
    }
  }

  async roomFor(parentSessionID: string, create = true): Promise<ArenaRoom | undefined> {
    const fresh = await this.refreshRoom(parentSessionID)
    if (fresh) return fresh
    if (!create) return undefined
    const room = new ArenaRoom(parentSessionID)
    this.rooms.set(parentSessionID, room)
    await this.saveRoom(room)
    this.ensureRoomTimer()
    return room
  }

  private async loadRoomSnapshot(parentSessionID: string): Promise<RoomSnapshot | undefined> {
    const raw = await this.deps.storage.get(`arena/room:${parentSessionID}`).catch(() => undefined)
    if (typeof raw !== "string") return undefined
    try {
      const snapshot = readStored<RoomSnapshot>(raw)
      if (!snapshot) return undefined
      if (snapshot.parentSessionID !== parentSessionID) return undefined
      return snapshot
    } catch {
      return undefined
    }
  }

  private async saveRoom(room: ArenaRoom): Promise<void> {
    const stored = await this.loadRoomSnapshot(room.parentSessionID)
    if (stored) room.absorb(stored)
    await this.deps.storage.set(`arena/room:${room.parentSessionID}`, JSON.stringify(room.toJSON()))
    if (!this.roomIDs.has(room.parentSessionID)) {
      this.roomIDs.add(room.parentSessionID)
      await this.deps.storage.set("arena/rooms", JSON.stringify([...this.roomIDs]))
    }
  }

  private ensureRoomTimer(): void {
    if (this.roomTimer) return
    this.roomTimer = setInterval(() => {
      void this.pollRooms()
    }, 1500)
    ;(this.roomTimer as unknown as { unref?: () => void }).unref?.()
  }

  private tickFields(): void {
    for (const run of [...this.fields.values()]) void run.tick().catch(() => undefined)
    void this.sweepFields().catch(() => undefined)
  }

  private async pollRooms(): Promise<void> {
    if (this.roomPolling) return
    this.roomPolling = true
    try {
      for (const room of this.rooms.values()) {
        let changed = false
        for (const participant of room.list()) {
          if (!participant.typing) continue
          if (!participant.typingAt || Date.now() - participant.typingAt < 180_000) continue
          room.setTyping(participant.label, false)
          if (participant.status === "working") room.setStatus(participant.label, "idle")
          changed = true
        }
        if (changed) await this.saveRoom(room)
      }
      this.tickFields()
    } finally {
      this.roomPolling = false
    }
  }

  private roomEnvelope(room: ArenaRoom, message: RoomMessage): string {
    const fromPrincipal = message.authorRole === "user" || message.authorRole === "orchestrator"
    const instruction = message.order
      ? "This is a direct order from the User or the Orchestrator. Follow it at the next safe point; if it is impossible, say why in the room."
      : fromPrincipal
        ? "This message is from the User or the Orchestrator. Answer it in the room with arena_bus post when it asks something or needs a decision; do not stay silent."
        : "Room message. Act only if it changes your work; reply with arena_bus post when useful."
    const to = message.to === "all" ? "all" : message.to.join(", ")
    return `[arena.room ${message.id} from ${message.author} to ${to}] ${message.text}\n${instruction}\nRead the room with arena_bus read; post with arena_bus post.`
  }

  private coordinatorEnvelope(room: ArenaRoom, message: RoomMessage): string {
    const to = message.to === "all" ? "all" : message.to.join(", ")
    return `[arena.room ${message.id} from ${message.author} to ${to}] ${message.text}
You are the coordinator, not a worker. Do not use shell, read, edit, browser or subagent tools while the field is live. Use arena status/read to inspect the room, and arena chat or steer to guide the crew. Answer the User, and if the message asks for work, name the owner in the room instead of doing it yourself. Do not answer with a poll loop: the next room update wakes you.`
  }

  private async deliverRoom(room: ArenaRoom, message: RoomMessage, except?: string): Promise<number> {
    let delivered = 0
    for (const participant of room.list()) {
      if (participant.role !== "agent") continue
      if (!participant.sessionID) continue
      if (isSealed(participant.sessionID)) continue
      if (participant.label === message.author) continue
      if (except && participant.label === except) continue
      const route = room.route(message, participant)
      if (route === "ignore" && message.kind !== "lifecycle") continue
      const finished = ["done", "stopped", "failed"].includes(participant.status)
      const live = route === "steer" || route === "queue"
      const fromPrincipal = message.authorRole === "user" || message.authorRole === "orchestrator"
      const wake = fromPrincipal || message.order || message.mentions.includes(participant.label) || message.kind === "goal"
      const resume = live && (!finished || wake)
      try {
        await this.deps.runtime.synthetic(participant.sessionID, this.roomEnvelope(room, message), {
          delivery: route === "steer" ? "steer" : "queue",
          resume,
          metadata: {
            arena: {
              roomID: room.id,
              messageID: message.id,
              runID: message.runID ?? "",
              label: participant.label,
            },
          },
        })
        if (resume) participant.status = "working"
        participant.lastSeen = Date.now()
        delivered++
      } catch {
        // The room keeps the message even if a live delivery fails.
      }
    }
    return delivered
  }

  retire(): void {
    if (this.roomTimer) clearInterval(this.roomTimer)
    this.roomTimer = undefined
    for (const run of this.fields.values()) run.detach()
    this.fields.clear()
  }

  async dispose(): Promise<void> {
    this.retire()
    for (const run of [...this.fields.values()]) {
      await run.stop("stopped", "the plugin was disposed", false).catch(() => undefined)
    }
    this.fields.clear()
  }
}
