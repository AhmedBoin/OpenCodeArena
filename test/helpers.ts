import { resetSeals } from "../src/seal.ts"
import { ArenaService } from "../src/service.ts"
import type { ArenaRuntime, SessionCreateInput, SessionInfoLite, WaitOutcome } from "../src/runtime.ts"
import type { GitState, Workspace, WorkspacePort } from "../src/workspace.ts"
import type { ModelRef, ProblemContract, Usage, VerificationResult } from "../src/types.ts"

export type PromptPhase =
  | "explore"
  | "revise"
  | "judge"
  | "planner"
  | "worker"
  | "integrator"
  | "evolve"
  | "helper"
  | "repair"
  | "other"

export function detectPhase(text: string): PromptPhase {
  if (text.startsWith("Your previous reply did not satisfy")) return "repair"
  if (text.includes("You are the independent judge")) return "judge"
  if (text.includes("You are the planner of a cooperative agent team")) return "planner"
  if (text.includes("You are the integrator of a cooperative team")) return "integrator"
  if (text.includes("You are a native OpenCode subagent")) return "helper"
  if (text.includes("collaboration and revision")) return "revise"
  if (text.includes("candidate in a verifier-driven evolutionary arena")) return "evolve"
  if (text.includes("worker on a cooperative team")) return "worker"
  if (text.includes("competitor and teammate in an arena")) return "explore"
  return "other"
}

export function labelOf(text: string): string | undefined {
  return /You are (C\d+)/.exec(text)?.[1]
}

export function judgeLabels(text: string): string[] {
  return [...text.matchAll(/^--- (C\d+) ---$/gm)].map((match) => match[1] as string)
}

export function plannerLabels(text: string): string[] {
  return [...new Set([...text.matchAll(/^- (C\d+):/gm)].map((match) => match[1] as string))]
}

export interface RespondInput {
  sessionID: string
  role: string
  label: string
  phase: PromptPhase
  prompt: string
  call: number
}

export interface FakeOptions {
  respond?: (input: RespondInput) => string
  agents?: { id: string; description?: string; mode?: string }[]
  usagePerSession?: Usage
  timeout?: (input: RespondInput) => boolean
  delayMs?: number
  missing?: string[]
}

export class FakeRuntime implements ArenaRuntime {
  readonly created: SessionCreateInput[] = []
  readonly prompts: {
    sessionID: string
    text: string
    phase: PromptPhase
    label?: string
    delivery?: "steer" | "queue"
    resume?: boolean
    files?: { name?: string; mime: string; data: string }[]
  }[] = []
  readonly injected: { sessionID: string; key: string; value: unknown }[] = []
  readonly synthetics: {
    sessionID: string
    text: string
    delivery?: "steer" | "queue"
    resume?: boolean
    metadata?: Record<string, unknown>
  }[] = []
  readonly interrupted: string[] = []
  readonly removed: string[] = []
  readonly missing: string[]
  private readonly sessions = new Map<string, SessionCreateInput>()
  private readonly lastPrompt = new Map<string, string>()
  private readonly calls = new Map<string, number>()

  constructor(private readonly options: FakeOptions) {
    this.missing = [...(options.missing ?? [])]
  }

  async createSession(input: SessionCreateInput): Promise<string> {
    const id = `ses_${this.created.length + 1}`
    this.created.push(input)
    this.sessions.set(id, input)
    return id
  }

  async prompt(sessionID: string, text: string, options?: { delivery?: "steer" | "queue"; resume?: boolean; files?: { name?: string; mime: string; data: string }[] }): Promise<void> {
    this.prompts.push({
      sessionID,
      text,
      phase: detectPhase(text),
      label: labelOf(text),
      delivery: options?.delivery,
      resume: options?.resume,
      files: options?.files,
    })
    this.lastPrompt.set(sessionID, text)
  }

  async wait(sessionID: string): Promise<WaitOutcome> {
    const input = this.options
    const session = this.sessions.get(sessionID)
    const call = (this.calls.get(sessionID) ?? 0) + 1
    this.calls.set(sessionID, call)
    const prompt = this.lastPrompt.get(sessionID) ?? ""
    const result: RespondInput = {
      sessionID,
      role: String(session?.metadata?.arenaRole ?? "unknown"),
      label: String(session?.metadata?.arenaLabel ?? labelOf(prompt) ?? "?"),
      phase: detectPhase(prompt),
      prompt,
      call,
    }
    if (input.timeout?.(result)) return "timeout"
    if (input.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs))
    return "idle"
  }

  async finalText(sessionID: string): Promise<string> {
    const session = this.sessions.get(sessionID)
    const prompt = this.lastPrompt.get(sessionID) ?? ""
    const call = this.calls.get(sessionID) ?? 1
    return this.options.respond?.({
      sessionID,
      role: String(session?.metadata?.arenaRole ?? "unknown"),
      label: String(session?.metadata?.arenaLabel ?? labelOf(prompt) ?? "?"),
      phase: detectPhase(prompt),
      prompt,
      call,
    }) ?? "{}"
  }

  async contextMessages(): Promise<readonly unknown[]> {
    return []
  }

  async usage(): Promise<Usage> {
    return this.options.usagePerSession ?? { costUSD: 0.01, tokens: 1000 }
  }

  async info(sessionID: string): Promise<SessionInfoLite> {
    if (this.missing.includes(sessionID)) throw new Error(`session ${sessionID} is gone`)
    const session = this.sessions.get(sessionID)
    return {
      id: sessionID,
      agent: session?.agent,
      model: session?.model,
      cost: 0.01,
      tokens: { input: 1000, output: 0 },
      metadata: session?.metadata as Record<string, unknown> | undefined,
      outcome: "succeeded",
      parentID: session?.parentID,
    }
  }

  async inject(sessionID: string, key: string, value: unknown): Promise<void> {
    this.injected.push({ sessionID, key, value })
  }

  async synthetic(sessionID: string, text: string, options?: { delivery?: "steer" | "queue"; resume?: boolean; metadata?: Record<string, unknown> }): Promise<void> {
    this.synthetics.push({ sessionID, text, delivery: options?.delivery, resume: options?.resume, metadata: options?.metadata })
  }

  async interrupt(sessionID: string): Promise<void> {
    this.interrupted.push(sessionID)
  }

  async remove(sessionID: string): Promise<void> {
    this.removed.push(sessionID)
  }

  async listAgents(): Promise<{ id: string; description?: string; mode?: string }[]> {
    return this.options.agents ?? [
      { id: "build", description: "build", mode: "primary" },
      { id: "plan", description: "plan", mode: "primary" },
      { id: "uncensored", description: "uncensored", mode: "subagent" },
    ]
  }

  async listAllAgents(): Promise<{ id: string; description?: string; mode?: string }[]> {
    return this.options.agents ?? [
      { id: "build", description: "build", mode: "primary" },
      { id: "plan", description: "plan", mode: "primary" },
      { id: "uncensored", description: "uncensored", mode: "subagent" },
    ]
  }

  promptsFor(label: string): string[] {
    return this.prompts.filter((prompt) => prompt.label === label).map((prompt) => prompt.text)
  }

  sessionFor(label: string): string | undefined {
    const input = this.created.find((session) => session.metadata?.arenaLabel === label && session.metadata?.arenaRole === "contestant")
    return input ? `ses_${this.created.indexOf(input) + 1}` : undefined
  }
}

export interface FakeWorkspaceOptions {
  git?: boolean
  /** Default true: /repo is a project root, not a home/drive root. */
  canIsolate?: boolean
  path?: string
  diff?: (label: string) => string
  verify?: (label: string) => VerificationResult
}

export class FakeWorkspace implements WorkspacePort {
  readonly removed: Workspace[] = []
  constructor(private readonly options: FakeWorkspaceOptions = {}) {}

  async probe(): Promise<GitState> {
    return { git: this.options.git ?? false, root: "/repo" }
  }

  async canIsolate(): Promise<boolean> {
    return this.options.canIsolate ?? true
  }

  async create(_root: string, runID: string, label: string, useWorktrees: boolean): Promise<Workspace> {
    if (!useWorktrees || !(this.options.git ?? false)) {
      return { label, path: this.options.path ?? "/repo", isolated: false }
    }
    return { label, path: `/ws/${runID}/${label}`, branch: `arena/${runID}/${label}`, isolated: true }
  }

  async remove(_root: string, workspace: Workspace): Promise<void> {
    this.removed.push(workspace)
  }

  async changedFiles(): Promise<string[]> {
    return []
  }

  async diff(workspace: Workspace): Promise<string> {
    return this.options.diff?.(workspace.label) ?? `diff for ${workspace.label}`
  }

  async verify(
    workspace: Workspace,
    _command: string | undefined,
    label: string,
  ): Promise<VerificationResult> {
    if (this.options.verify) return this.options.verify(label)
    return { label, exitCode: 0, output: `verified ${workspace.label}`, durationMs: 10, passed: true, command: _command }
  }
}

export const contract: ProblemContract = {
  objective: "Fix the duplicate webhook order bug without changing the public API",
  constraints: ["keep the public API"],
  successCriteria: ["duplicate events create exactly one order"],
  nonGoals: [],
}

export function submissionJSON(input: {
  label: string
  quality?: number
  escalate?: string[]
  blocked?: string
  evidence?: { command: string; result: string }[]
  files?: string[]
  approach?: string
  claim?: string
}): string {
  const quality = input.quality ?? 3
  return JSON.stringify({
    approach: input.approach ?? `${input.label} approach level ${quality}`,
    claim: input.claim ?? `${input.label} satisfies the success criteria at level ${quality}`,
    patch: `patch from ${input.label}`,
    files: input.files ?? ["src/webhook.ts"],
    evidence: input.evidence ?? [{ command: "bun test", result: `${quality} tests passed` }],
    assumptions: [],
    risks: ["a boundary case may differ"],
    confidence: 0.7,
    blocked: input.blocked ?? "",
  })
}

export function revisionJSON(label: string, targets: string[]): string {
  return JSON.stringify({
    approach: `${label} revised approach after reading the bus`,
    claim: `${label} now covers the empty input path`,
    patch: `revised patch from ${label}`,
    files: ["src/webhook.ts"],
    evidence: [{ command: "bun test", result: "14 passed" }],
    assumptions: [],
    risks: [],
    confidence: 0.8,
    blocked: "",
    attacks: targets.map((target) => ({
      target,
      claim: `${target} still lacks a concurrency test`,
      test: `run two events in parallel against ${target}`,
      severity: "major",
    })),
    support: [],
    changedMind: true,
  })
}

export function verdictJSON(input: {
  labels: string[]
  decision: "accept" | "reject_all"
  winner?: string
  scores?: Record<string, number>
  reasoning?: string
  focus?: string
  merged?: string[]
}): string {
  return JSON.stringify({
    decision: input.decision,
    winner: input.decision === "accept" ? (input.winner ?? input.labels[0]) : null,
    merged: input.merged ?? [],
    scores: input.labels.map((label) => {
      const value = input.scores?.[label] ?? 3
      return {
        candidate: label,
        correctness: value,
        evidence: value,
        robustness: value,
        simplicity: value,
        assumptions: value,
        fatalFlaws: [],
        notes: `${label} scored ${value}`,
      }
    }),
    reproduced: [{ command: "bun test", result: "12 passed" }],
    reasoning: input.reasoning ?? `Decision ${input.decision} from the verification I ran.`,
    nextRoundFocus: input.focus ?? "verify the empty input path",
  })
}

export function teamPlanJSON(tasks: { title: string; owner: string; files?: string[]; acceptance?: string }[]): string {
  return JSON.stringify({
    tasks: tasks.map((task) => ({
      title: task.title,
      owner: task.owner,
      files: task.files ?? [],
      acceptance: task.acceptance ?? "tests pass",
    })),
  })
}

export function workReportJSON(input: { summary?: string; status?: "done" | "blocked"; files?: string[]; blocked?: string }): string {
  return JSON.stringify({
    status: input.status ?? "done",
    summary: input.summary ?? "implemented the slice and ran the tests",
    files: input.files ?? ["src/webhook.ts"],
    evidence: [{ command: "bun test", result: "12 passed" }],
    blocked: input.blocked ?? "",
  })
}

export interface Harness {
  service: ArenaService
  runtime: FakeRuntime
  workspace: FakeWorkspace
  store: Map<string, string>
  synthetics: { sessionID: string; text: string }[]
}

export function makeHarness(
  respond: (input: RespondInput) => string,
  options: {
    fake?: FakeOptions
    workspace?: FakeWorkspaceOptions
    parentAgent?: string
    parentModel?: ModelRef
  } = {},
): Harness {
  resetSeals()
  const runtime = new FakeRuntime({ respond, ...options.fake })
  const workspace = new FakeWorkspace(options.workspace)
  const store = new Map<string, string>()
  return { ...wire(respond, runtime, workspace, store, options), store }
}

/** A second service over the same storage — used to simulate a plugin reload. */
export function makeHarnessFrom(
  store: Map<string, string>,
  respond: (input: RespondInput) => string = () => "{}",
  options: {
    fake?: FakeOptions
    workspace?: FakeWorkspaceOptions
    parentAgent?: string
    parentModel?: ModelRef
    /** Simulate a plugin hot reload instead of a fresh process. */
    hotReload?: boolean
  } = {},
): Harness {
  const runtime = new FakeRuntime({ respond, ...options.fake })
  const workspace = new FakeWorkspace(options.workspace)
  if (!options.hotReload) {
    // A real process restart loses the in-memory "already resumed" marker and
    // the sealed-session registry.
    delete (globalThis as typeof globalThis & { __opencodeArenaSeenRuns?: Set<string> }).__opencodeArenaSeenRuns
    resetSeals()
  }
  return wire(respond, runtime, workspace, store, options)
}

function wire(
  respond: (input: RespondInput) => string,
  runtime: FakeRuntime,
  workspace: FakeWorkspace,
  store: Map<string, string>,
  options: {
    fake?: FakeOptions
    workspace?: FakeWorkspaceOptions
    parentAgent?: string
    parentModel?: ModelRef
  },
): Harness {
  void respond
  const synthetics: { sessionID: string; text: string }[] = []
  const service = new ArenaService({
    runtime,
    workspace,
    root: "/repo",
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value)
      },
    },
    synthetic: async (sessionID, text) => {
      synthetics.push({ sessionID, text })
    },
    parentInfo: async () => ({ agent: options.parentAgent ?? "build", model: options.parentModel }),
  })
  return { service, runtime, workspace, store, synthetics }
}
