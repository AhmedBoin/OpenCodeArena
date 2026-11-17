import type { HostPort, ToolSpec } from "./host/port.ts"
import { parseModel } from "./model.ts"
import type { ArenaService } from "./service.ts"
import type { ArenaOptions } from "./config.ts"
import type { CrewSpec, ProblemContract } from "./types.ts"

interface ArenaToolInput {
  action: string
  objective?: string
  constraints?: string[]
  successCriteria?: string[]
  nonGoals?: string[]
  verification?: string
  metricRegex?: string
  context?: string
  contestants?: number
  crew?: { name?: string; role?: string; brief?: string; agent?: string }[]
  agentType?: string
  sameRole?: string
  workspaceMode?: string
  agents?: string[]
  models?: string[]
  foremanAgent?: string
  foremanModel?: string
  network?: boolean
  toolPolicy?: "arena" | "all"
  maxDurationMinutes?: number
  maxTurns?: number
  maxSteps?: number
  checkEveryMinutes?: number
  mentionTimeoutSeconds?: number
  leaseMinutes?: number
  runID?: string
  message?: string
  targets?: string[]
  label?: string
  sessionID?: string
  to?: string
  private?: boolean
  order?: boolean
  kind?: string
  ids?: string[]
  keep?: boolean
  after?: string
  task?: string
  agent?: string
  model?: string
  reason?: string
  goal?: string
  command?: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  resource?: string
  path?: string
  content?: string
  encoding?: "utf8" | "base64"
  from?: string
  jobID?: string
}

interface BusToolInput {
  action: string
  kind?: string
  to?: string
  text?: string
  reason?: string
  runID?: string
  label?: string
  id?: string
  after?: string
  replyTo?: string
  replyInSeconds?: number
  area?: string
  leaseMinutes?: number
  leaseKind?: string
  paths?: string[]
  evidence?: string[]
  coverage?: string[]
  basedOn?: string[]
  contradicts?: string[]
  arbitration?: string
  result?: string
  experiment?: string
  command?: string
  expect?: string
  killIf?: string
  preflight?: string
  baseline?: string
  observed?: string
  pidBefore?: string
  pidAfter?: string
  oracleKind?: string
  baselineAt?: number
  scope?: string
  writer?: string
}

interface GitToolInput {
  action: string
  message?: string
  from?: string
  paths?: string[]
  take?: "ours" | "theirs"
  limit?: number
}

interface SpawnToolInput {
  agent: string
  prompt: string
  model?: string
  timeoutMs?: number
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function toRoom(input: ArenaToolInput): string[] | "all" | undefined {
  const targets = asStringArray(input.targets)
  if (targets && targets.length > 0) return targets
  const to = asString(input.to)
  if (!to) return undefined
  if (to.toLowerCase() === "all") return "all"
  return [to]
}

function contractFrom(input: ArenaToolInput): ProblemContract {
  const successCriteria =
    input.successCriteria && input.successCriteria.length > 0
      ? input.successCriteria
      : [input.verification ? "The objective is met and the verification command passes" : "The objective is met"]
  return {
    objective: (input.objective ?? "").trim(),
    constraints: input.constraints ?? [],
    successCriteria,
    verificationCommand: asString(input.verification),
    metricRegex: asString(input.metricRegex),
    nonGoals: input.nonGoals ?? [],
    context: asString(input.context),
  }
}

function optionsFrom(input: ArenaToolInput): ArenaOptions {
  const crew: CrewSpec[] = []
  for (const seat of input.crew ?? []) {
    const name = asString(seat?.name)
    const brief = asString(seat?.brief)
    if (!name || !brief) continue
    crew.push({ name, role: asString(seat?.role) ?? "Independent", brief, agent: asString(seat?.agent) })
  }
  return {
    contestants: asNumber(input.contestants),
    crew,
    agentType: asString(input.agentType),
    sameRole: asString(input.sameRole),
    workspaceMode:
      input.workspaceMode === "shared" || input.workspaceMode === "copy" ? input.workspaceMode : undefined,
    agents: asStringArray(input.agents),
    models: asStringArray(input.models),
    foremanAgent: asString(input.foremanAgent),
    foremanModel: asString(input.foremanModel),
    network: input.network,
    toolPolicy: input.toolPolicy === "arena" || input.toolPolicy === "all" ? input.toolPolicy : undefined,
    maxDurationMinutes: asNumber(input.maxDurationMinutes),
    maxTurns: asNumber(input.maxSteps) ?? asNumber(input.maxTurns),
    checkEveryMinutes: asNumber(input.checkEveryMinutes),
    mentionTimeoutSeconds: asNumber(input.mentionTimeoutSeconds),
    leaseMinutes: asNumber(input.leaseMinutes),
  }
}

function planText(preview: Awaited<ReturnType<ArenaService["preview"]>>): string {
  const plan = preview.plan
  const lines = [
    `Plan: field (continuous), ${plan.contestants} agents, no per-agent step budget${plan.maxDurationMinutes > 0 ? `, ${plan.maxDurationMinutes} minute User limit` : ", no deadline"}. Only the User can stop it; each agent leaves by its own decision.`,
    `Execution: continuous, self-coordinating. The agents negotiate area leases in the room; Vera the referee checks the board every ${Math.round(plan.checkEveryMs / 60_000)}m. There are no rounds, steps or judge scoreboard.`,
    `Crew: ${plan.crew.map((seat) => `${seat.name} (${seat.role})`).join(", ")}.`,
    `Oracle: ${plan.oracle?.observable ?? "unset"}. Baseline: ${plan.oracle?.baseline ?? "capture before the first test"}.`,
    `Seat agents: ${plan.agents.join(", ")}. Models: ${plan.models.length > 0 ? plan.models.map((model) => `${model.providerID}/${model.id}`).join(", ") : "session default"}. Referee: ${plan.foremanAgent}${plan.foremanModel ? ` (${plan.foremanModel.providerID}/${plan.foremanModel.id})` : ""} (Vera).`,
    `Mentions: ${Math.round(plan.mentionTimeoutMs / 1_000)}s reply window. Area leases: ${Math.round(plan.intentLeaseMs / 60_000)}m.`,
    `Workspace: ${plan.workspaceMode === "copy" ? "copy-on-write (shared read baseline, per-agent writable copy)" : "shared (a crew edits one tree)"}${plan.sameRole ? `; same role: ${plan.sameRole}${plan.sameRoleInferred ? " (inferred)" : ""}` : ""}. Network: ${plan.allowNetwork ? "on" : "off"}. Tools: ${plan.toolPolicy === "arena" ? "Arena allowlist" : "all host, MCP, browser and subagent tools"}.`,
    `Why: ${plan.reason}.`,
    `Available agents: ${preview.agents.map((agent) => agent.id).join(", ") || "none discovered"}.`,
  ]
  return lines.join("\n")
}

const JSON_SCHEMA = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

interface RegisteredTool {
  name: string
  description: string
  input: unknown
  options?: { codemode?: boolean }
  execute: (
    raw: unknown,
    toolCtx: { sessionID: string; signal: AbortSignal; progress: () => Promise<void> },
  ) => Promise<{ content: string; metadata?: unknown }>
}

export async function registerArenaTools(host: HostPort, service: ArenaService) {
  const specs: RegisteredTool[] = []
  const add = (spec: RegisteredTool) => {
    // Code Mode-only tools are invisible to field seats: the seat's own
    // `execute` is guarded, and a plugin tool nested inside it cannot be
    // reached. Register every Arena tool as a direct function instead.
    specs.push({ options: { codemode: false }, ...spec })
  }
  {
    add({
      name: "arena",
      description:
        "Control the Arena field: agents you design work one goal continuously on a shared bus, Vera the referee watches for stalls, and a claim only closes the field when verification passes. Any primary agent can start a field; no dedicated orchestrator agent is required. After start you are the coordinator, not a worker: do not investigate or run debuggers. Use arena status/read to inspect the room and arena chat or steer to guide the crew. The crew self-coordinates from a state card: one oracle, one running experiment, typed facts, and a lease before a write or launch. A request/question mention is an answer obligation; an acknowledgment is never a message. Only the User can stop the field or force an agent to leave; you cannot. Agents leave by their own decision, permanently. The natural-language trigger is: when the user says \"make an arena of N agents that ...\", design a crew (real names, perspectives and personalities tailored to the task) and call action start with the objective and the crew. If the user did not give N, choose the crew size yourself: 3 by default, 4 for a multi-lane task, 50+ only for an explicit independent fan-out. Actions: plan, start, status, chat, steer, read, consume, finish, update, report, list. The background field keeps the main session free; the agents are real child sessions.",
      input: JSON_SCHEMA(
        {
          action: {
            type: "string",
            enum: ["plan", "start", "continue", "status", "stop", "chat", "steer", "read", "consume", "halt", "finish", "update", "report", "list"],
            description: "What to do.",
          },
          objective: { type: "string", description: "The outcome to reach, in one sentence." },
          constraints: { type: "array", items: { type: "string" } },
          successCriteria: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
          verification: { type: "string", description: "Command the gate runs before accepting a claim." },
          metricRegex: { type: "string" },
          context: { type: "string" },
          contestants: {
            type: "number",
            description:
              "How many agents when you did not design a crew. Omit to let the plugin pick from the contract.",
          },
          crew: {
            type: "array",
            description:
              "Design the crew yourself: one real name, a perspective, and a short personality brief written for this task. Do not assign fixed slices or write that someone owns an area; ownership is negotiated in the room. Providing a crew overrides contestants.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "A real first name, unique in the crew." },
                role: { type: "string", description: "The seat's role in this task, for example 'Concurrency skeptic'." },
                brief: { type: "string", description: "How this person thinks, what they own, and how they work with others." },
                agent: { type: "string", description: "Optional OpenCode agent id for this seat, for example build or uncensored." },
              },
              required: ["name", "brief"],
              additionalProperties: false,
            },
          },
          agentType: {
            type: "string",
            description:
              "OpenCode agent id every seat runs as, for example build, plan or uncensored. A seat's own agent wins over this.",
          },
          sameRole: {
            type: "string",
            description:
              "Every seat gets this same role, for example Builder or Software Engineer. Independent whole-problem work; each agent leaves on its own.",
          },
          workspaceMode: {
            type: "string",
            enum: ["shared", "copy"],
            description:
              "shared: one tree; copy: each agent gets a writable copy/worktree and reads the shared baseline. sameRole defaults to copy.",
          },
          agents: {
            type: "array",
            items: { type: "string" },
            description: "Host agent ids to cycle across seats when agentType is not set.",
          },
          models: {
            type: "array",
            items: { type: "string" },
            description: "Optional provider/model per seat. Omit to use the session default.",
          },
          foremanAgent: { type: "string", description: "Agent id for Vera, the referee. Default: plan." },
          foremanModel: { type: "string" },
          network: {
            type: "boolean",
            description: "Accepted for compatibility. Network access is always on; this flag never disables fetch, search or browser.",
          },
          toolPolicy: {
            type: "string",
            enum: ["arena", "all"],
            description:
              "arena = strict field allowlist; all = host shell/write/edit, MCP, browser, skill and subagent tools are available too. Default all.",
          },
          maxDurationMinutes: {
            type: "number",
            description: "Optional User-set wall clock limit. Default 0: continuous, only the User stops it.",
          },
          maxSteps: {
            type: "number",
            description: "Ignored. The field is continuous and has no per-agent step budget.",
          },
          maxTurns: { type: "number", description: "Deprecated alias for maxSteps; ignored." },
          checkEveryMinutes: { type: "number", description: "Referee check interval. Default 2." },
          mentionTimeoutSeconds: {
            type: "number",
            description: "How long a named mention waits for an answer. Default 60, range 10 to 600.",
          },
          leaseMinutes: {
            type: "number",
            description: "Default area lease before it expires. Default 10, range 1 to 60.",
          },
          runID: { type: "string" },
          message: { type: "string", description: "Message for chat, steer, halt, report, or the claim summary for finish." },
          targets: { type: "array", items: { type: "string" }, description: "Names to address, for example [\"Ada\"]." },
          label: { type: "string", description: "Participant name for update or consume." },
          sessionID: { type: "string" },
          to: { type: "string", description: "Mention a name, for example Ada; everyone still sees the message." },
          private: { type: "boolean", description: "Ignored: every room message is global." },
          order: { type: "boolean", description: "Mark the message as a direct order." },
          kind: { type: "string", enum: ["chat", "finding", "question", "answer", "request", "dead-end", "claim", "goal", "order", "directive"] },
          ids: { type: "array", items: { type: "string" }, description: "Message ids to keep or drop from a participant's context." },
          keep: { type: "boolean", description: "Keep the ids instead of dropping them." },
          after: { type: "string", description: "Read messages after this id." },
          task: { type: "string", description: "New task or instruction for a participant." },
          agent: { type: "string" },
          model: { type: "string" },
          reason: { type: "string" },
          goal: { type: "string", description: "Evidence text when an agent claims the goal." },
        },
        ["action"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as ArenaToolInput
        const action = input.action
        const binding = service.bindings.get(toolCtx.sessionID)
        const agentActions = new Set(["status", "report", "read", "consume", "finish", "leave"])
        if (binding && !agentActions.has(action)) {
          return { content: "Only the main session controls the arena. Agents can use arena_bus, arena read, arena consume, and arena finish." }
        }
        try {
          if (action === "plan") {
            const contract = contractFrom(input)
            if (contract.objective.length < 8) return { content: "Give an objective of at least one sentence." }
            const preview = await service.preview(contract, optionsFrom(input), toolCtx.sessionID)
            return { content: planText(preview), metadata: { plan: preview.plan } }
          }
          if (action === "start") {
            const contract = contractFrom(input)
            const started = await service.startField(contract, optionsFrom(input), toolCtx.sessionID)
            return { content: started.text, metadata: { runID: started.runID } }
          }
          if (action === "continue") {
            const mission = asString(input.message) ?? asString(input.objective)
            if (!mission) return { content: "continue needs a new mission in message or objective." }
            return { content: await service.startFromCommand(`/arena continue ${mission}`, toolCtx.sessionID) }
          }
          if (action === "status") {
            const status = await service.status(asString(input.runID), toolCtx.sessionID)
            return { content: status.text }
          }
          if (action === "stop") {
            return { content: "Only the User can stop a field. Use the Arena panel or type stop in the room." }
          }
          if (action === "chat" || action === "steer") {
            const text = asString(input.message)
            if (!text) return { content: `${action} needs a message.` }
            const result = await service.chat({
              parentSessionID: toolCtx.sessionID,
              runID: asString(input.runID),
              callerSessionID: toolCtx.sessionID,
              authorRole: "orchestrator",
              text,
              to: toRoom(input),
              // A steer is an order by default, but the coordinator can pass
              // order:false to speak without spending the order budget. A plain
              // chat never counts as an order.
              order: action === "steer" ? input.order !== false : input.order === true,
              private: input.private === true,
              kind: input.kind as never,
            })
            return { content: typeof result === "string" ? result : result.text }
          }
          if (action === "read") {
            return {
              content: await service.readRoom({
                parentSessionID: toolCtx.sessionID,
                runID: asString(input.runID),
                after: asString(input.after),
                sessionID: toolCtx.sessionID,
              }),
            }
          }
          if (action === "consume") {
            const ids = input.ids ?? []
            if (ids.length === 0) return { content: "consume needs ids, for example [\"m4\", \"m5\"]." }
            const label = asString(input.label) ?? binding?.label
            if (!label) return { content: "consume needs a label." }
            return {
              content: await service.consumeRoom({
                parentSessionID: toolCtx.sessionID,
                runID: asString(input.runID),
                label,
                ids,
                keep: input.keep === true,
                sessionID: toolCtx.sessionID,
              }),
            }
          }
          if (action === "halt") {
            return {
              content: await service.haltRoom({
                parentSessionID: toolCtx.sessionID,
                runID: asString(input.runID),
                author: "Orchestrator",
                reason: asString(input.reason) ?? asString(input.message) ?? "stop requested",
                to: toRoom(input),
              }),
            }
          }
          if (action === "finish") {
            return {
              content: await service.finishParticipant({
                sessionID: toolCtx.sessionID,
                runID: asString(input.runID),
                label: binding?.label ?? asString(input.label),
                summary: asString(input.message),
                goal: asString(input.goal),
              }),
            }
          }
          if (action === "update") {
            const label = asString(input.label)
            if (!label) return { content: "update needs the participant label." }
            return {
              content: await service.updateParticipant({
                parentSessionID: toolCtx.sessionID,
                runID: asString(input.runID),
                label,
                task: asString(input.task),
                agent: asString(input.agent),
                model: asString(input.model),
                author: "Orchestrator",
              }),
            }
          }
          if (action === "report") return { content: await service.report(asString(input.runID), toolCtx.sessionID) }
          if (action === "list") return { content: await service.list() }
          return { content: `Unknown action ${action}.` }
        } catch (error) {
          return { content: `Arena error: ${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })

    add({
      name: "arena_bus",
      description:
        "Read or post on the shared Arena bus. Verbs: take (intent), release (handoff), fact (claim + evidence), test (one command + expected result), result (pass/fail/invalid), ask (request), leave (end your own participation permanently). A named @mention is an answer obligation only for request/question; @all is attention. There are no rounds or step counts. The board's state card already carries the truth; post a fact only when it changes the card.",
      input: JSON_SCHEMA(
        {
          action: { type: "string", enum: ["read", "post", "release", "resolve", "leave"] },
          kind: {
            type: "string",
            enum: [
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
            ],
          },
          to: { type: "string", description: "Mention a name such as Ada; every peer still sees the message." },
          text: { type: "string" },
          reason: { type: "string", description: "Alias for text on action=leave." },
          runID: { type: "string", description: "Arena run id, when the session has no binding." },
          label: { type: "string", description: "Your name, for example Ada." },
          id: { type: "string", description: "For read: return one full message by id, for example m4." },
          after: { type: "string", description: "For read: only messages after this id." },
          replyTo: { type: "string", description: "The message id you are answering, for example m4." },
          replyInSeconds: {
            type: "number",
            description: "How long the sender should wait for this answer. Default is the field window, 60s.",
          },
          area: { type: "string", description: "For intent or handoff: the file, module or area you claim." },
          leaseMinutes: { type: "number", description: "For intent: how long the claim lasts. Default 5, range 1 to 60." },
          leaseKind: {
            type: "string",
            enum: ["read", "write", "launch"],
            description: "For intent: what the lease protects. Two writes or launches on the same path cannot overlap.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "For intent: the concrete files or resources the lease covers. Defaults to area.",
          },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "For a claim or fact: the commands and their real output.",
          },
          coverage: {
            type: "array",
            items: { type: "string" },
            description:
              "For a claim: what was proven and what was not. A coverage claim closes honestly when the original objective was broader than the reachable result.",
          },
          basedOn: {
            type: "array",
            items: { type: "string" },
            description: "For a fact: the room message ids or fact ids this claim depends on.",
          },
          contradicts: {
            type: "array",
            items: { type: "string" },
            description: "For a fact or dead-end: the fact ids this claim contradicts. The board opens one arbitration.",
          },
          arbitration: {
            type: "string",
            description: "For resolve: the arbitration id the board opened.",
          },
          result: {
            type: "string",
            description: "For resolve: the decisive result starting with the winning fact id. For result: pass, fail, or invalid.",
          },
          experiment: {
            type: "string",
            description: "For result: the experiment id, for example e1.",
          },
          command: {
            type: "string",
            description: "For test: exactly one command that produces the observation.",
          },
          expect: {
            type: "string",
            description: "For test: the observable pass condition. Required.",
          },
          killIf: {
            type: "string",
            description: "For test: the observation that refutes the hypothesis.",
          },
          preflight: {
            type: "string",
            description: "For test: the check that must pass before the command, for example no Acrobat process alive.",
          },
          baseline: {
            type: "string",
            description: "For oracle or test: the pre-state (PID set, hash, or registry values).",
          },
          observed: {
            type: "string",
            description: "For result: the raw output or post-state you actually saw.",
          },
          pidBefore: {
            type: "string",
            description: "For result: the process id(s) before the launch. If it equals pidAfter, the result is invalid.",
          },
          pidAfter: {
            type: "string",
            description: "For result: the process id(s) after the launch.",
          },
          oracleKind: {
            type: "string",
            enum: ["ui", "file", "http", "process", "registry", "command"],
            description: "For oracle: what kind of observation the baseline captures.",
          },
          baselineAt: {
            type: "number",
            description: "For oracle: epoch ms of the observation. A baseline before this field started is rejected.",
          },
          scope: {
            type: "string",
            description: "For oracle: the process/file/path this observation owns. A global or historical log is rejected.",
          },
          writer: {
            type: "string",
            description: "For oracle: the PID, session or writer that produced the observation.",
          },
        },
        ["action"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as BusToolInput
        const runID = asString(input.runID)
        const label = asString(input.label)
        if (input.action === "read") {
          return {
            content: await service.busRead(
              toolCtx.sessionID,
              runID,
              label,
              asString(input.after),
              asString(input.id),
            ),
          }
        }
        if (input.action === "leave") {
          return {
            content: await service.leaveParticipant(
              toolCtx.sessionID,
              asString(input.text) ?? asString(input.reason) ?? "my work here is done",
            ),
          }
        }
        if (input.action === "release") {
          return {
            content: await service.busPost(
              toolCtx.sessionID,
              "handoff",
              asString(input.text) ?? "released",
              undefined,
              runID,
              label,
              undefined,
              undefined,
              undefined,
              asString(input.area),
            ),
          }
        }
        if (input.action === "resolve") {
          const arbitration = asString(input.arbitration)
          const result = asString(input.result)
          if (!arbitration || !result) return { content: "resolve needs arbitration and result." }
          return { content: await service.resolveArbitration(toolCtx.sessionID, arbitration, result) }
        }
        if (input.action === "post") {
          const text = asString(input.text)
          if (!text) return { content: "post needs text." }
          const kind = asString(input.kind) ?? "finding"
          const evidence = asStringArray(input.evidence)
          return {
            content: await service.busPost(
              toolCtx.sessionID,
              kind,
              text,
              asString(input.to),
              runID,
              label,
              asString(input.replyTo),
              evidence,
              asNumber(input.replyInSeconds),
              asString(input.area),
              asNumber(input.leaseMinutes),
              asString(input.leaseKind),
              asStringArray(input.paths),
              asStringArray(input.basedOn),
              asStringArray(input.contradicts),
              asString(input.command),
              asString(input.expect),
              asString(input.killIf),
              asString(input.preflight),
              asString(input.baseline),
              asString(input.experiment),
              input.result === "pass" || input.result === "fail" || input.result === "invalid"
                ? input.result
                : undefined,
              asString(input.observed),
              asString(input.pidBefore),
              asString(input.pidAfter),
              input.oracleKind === "ui" ||
                input.oracleKind === "file" ||
                input.oracleKind === "http" ||
                input.oracleKind === "process" ||
                input.oracleKind === "registry" ||
                input.oracleKind === "command"
                ? input.oracleKind
                : undefined,
              asNumber(input.baselineAt),
              asString(input.scope),
              asString(input.writer),
              asStringArray(input.coverage),
            ),
          }
        }
        return { content: "arena_bus action must be read or post." }
      },
    })

    add({
      name: "arena_git",
      description:
        "Branch-level git for a copy-on-write field seat. Actions: status, diff, log, commit, merge, abort, resolve. commit checkpoints your branch. merge --from <agent> runs git merge --no-ff --no-commit, refuses a dirty target, reports conflicts, and runs the field verification before committing; abort rolls back. resolve --take ours|theirs --paths <files> resolves conflict markers. A shared tree has no seat branch, so merge is refused there.",
      input: JSON_SCHEMA(
        {
          action: {
            type: "string",
            enum: ["status", "diff", "log", "commit", "merge", "abort", "resolve"],
          },
          message: { type: "string", description: "Commit message for commit or merge." },
          from: { type: "string", description: "The peer label whose branch to merge." },
          paths: { type: "array", items: { type: "string" }, description: "Conflict paths for resolve." },
          take: { type: "string", enum: ["ours", "theirs"], description: "For resolve: which side to keep." },
          limit: { type: "number", description: "For log: number of commits. Default 10." },
        },
        ["action"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as GitToolInput
        const take = input.take === "theirs" ? "theirs" : input.take === "ours" ? "ours" : undefined
        return {
          content: await service.arenaGit(toolCtx.sessionID, {
            action: asString(input.action) ?? "",
            message: asString(input.message),
            from: asString(input.from),
            paths: asStringArray(input.paths),
            take,
            limit: asNumber(input.limit),
          }),
        }
      },
    })

    add({
      name: "arena_fs",
      description:
        "Read, diff, merge and mutate the Arena workspace without external shell/file tools. Actions: read, list, stat, status, diff, merge, write, copy, remove. merge is a git three-way merge from another agent's worktree; binary conflicts are never auto-merged. Writes/merges run under the Arena run lock; a copy-on-write agent may write only its own tree and may read the shared baseline or another agent's published copy.",
      input: JSON_SCHEMA(
        {
          action: { type: "string", enum: ["read", "list", "stat", "status", "diff", "merge", "write", "copy", "remove"] },
          path: { type: "string", description: "Workspace-relative path, or an absolute path inside the shared baseline/Arena temp copy." },
          content: { type: "string", description: "For write: new content; base64 when encoding=base64." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "For read/write: text or binary base64. Default utf8." },
          to: { type: "string", description: "For copy: destination path inside your writable workspace." },
          from: { type: "string", description: "For merge: the agent name whose worktree should be merged into yours." },
        },
        ["action"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as ArenaToolInput
        return {
          content: await service.arenaFs(toolCtx.sessionID, {
            action: input.action,
            path: asString(input.path),
            content: input.content,
            encoding: input.encoding === "base64" ? "base64" : input.encoding === "utf8" ? "utf8" : undefined,
            to: asString(input.to),
            from: asString(input.from),
          }),
        }
      },
    })

    add({
      name: "arena_exec",
      description:
        "Run a shell command inside the Arena workspace under the run lock. This replaces the host shell tool for field agents. Background jobs are allowed only in copy-on-write mode and return a job id for arena_job.",
      input: JSON_SCHEMA(
        {
          command: { type: "string", description: "Command to run in the agent's workspace." },
          cwd: { type: "string", description: "Optional workspace-relative directory." },
          timeoutMs: { type: "number", description: "Foreground timeout. Default 60000, max 120000; use background=true for longer work." },
          background: { type: "boolean", description: "Start a tracked background job; copy-on-write only." },
          resource: {
            type: "string",
            description:
              "In a shared tree, the one file/service this command touches. Different resources run in parallel; the same resource serializes.",
          },
        },
        ["command"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as ArenaToolInput
        return {
          content: await service.arenaExec(toolCtx.sessionID, {
            command: asString(input.command),
            cwd: asString(input.cwd),
            timeoutMs: asNumber(input.timeoutMs),
            background: input.background === true,
            resource: asString(input.resource),
          }),
        }
      },
    })

    add({
      name: "arena_job",
      description: "Inspect or stop an Arena background job. Actions: list, status, output, stop.",
      input: JSON_SCHEMA(
        {
          action: { type: "string", enum: ["list", "status", "output", "stop"] },
          jobID: { type: "string", description: "The job id returned by arena_exec background=true." },
        },
        ["action"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as ArenaToolInput
        return {
          content: service.arenaJob(toolCtx.sessionID, {
            action: input.action,
            jobID: asString(input.jobID),
          }),
        }
      },
    })

    add({
      name: "arena_spawn",
      description:
        "Start a native OpenCode subagent in a child session, using any visible agent (build, plan, explore, uncensored, or another agent id). The subagent shares the workspace, can use tools, and returns its final answer. Use it for a bounded side question; depth is limited.",
      input: JSON_SCHEMA(
        {
          agent: { type: "string", description: "Agent id, for example build, plan, explore, uncensored." },
          prompt: { type: "string", description: "A narrow task for the subagent." },
          model: { type: "string", description: "Optional provider/model override." },
          timeoutMs: { type: "number", description: "Optional timeout, default 300000." },
        },
        ["agent", "prompt"],
      ),
      execute: async (raw, toolCtx) => {
        const input = raw as SpawnToolInput
        const agent = asString(input.agent)
        const prompt = asString(input.prompt)
        if (!agent || !prompt) return { content: "arena_spawn needs agent and prompt." }
        if (input.model && !parseModel(input.model)) return { content: `Invalid model ${input.model}. Use provider/model.` }
        const result = await service.spawnSubagent(
          { agent, prompt, model: asString(input.model), timeoutMs: asNumber(input.timeoutMs) },
          toolCtx.sessionID,
        )
        return {
          content: result.ok ? result.text : `arena_spawn: ${result.text}`,
          metadata: { sessionID: result.sessionID, usage: result.usage },
        }
      },
    })
  }
  return host.tools.register(specs as unknown as ToolSpec[])
}
