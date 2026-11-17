import type { Plugin } from "@opencode/plugin"
import { finalAssistantText } from "./text.ts"
import type { ModelRef, Usage } from "./types.ts"

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface SessionCreateInput {
  title: string
  agent: string
  parentID: string
  model?: ModelRef
  location?: { directory: string }
  metadata?: Record<string, JsonValue>
  permissions?: PermissionRule[]
}

export interface SessionInfoLite {
  id: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: { input: number; output: number }
  metadata?: Record<string, unknown>
  outcome?: "succeeded" | "failed" | "interrupted"
  parentID?: string
  /** Last host-side activity observed for the session, when the host exposes it. */
  updatedAt?: number
}

export type WaitOutcome = "idle" | "timeout" | "error"

export interface PromptFile {
  data: string
  mime: string
  name?: string
}

export interface PromptOptions {
  delivery?: "steer" | "queue"
  resume?: boolean
  files?: PromptFile[]
  metadata?: Record<string, JsonValue>
}

export interface SyntheticOptions {
  delivery?: "steer" | "queue"
  resume?: boolean
  metadata?: Record<string, JsonValue>
}

export interface ArenaRuntime {
  createSession(input: SessionCreateInput): Promise<string>
  prompt(sessionID: string, text: string, options?: PromptOptions): Promise<void>
  wait(sessionID: string, timeoutMs: number): Promise<WaitOutcome>
  finalText(sessionID: string): Promise<string>
  contextMessages(sessionID: string): Promise<readonly unknown[]>
  usage(sessionID: string): Promise<Usage>
  info(sessionID: string): Promise<SessionInfoLite>
  inject(sessionID: string, key: string, value: JsonValue): Promise<void>
  synthetic(sessionID: string, text: string, options?: SyntheticOptions): Promise<void>
  interrupt(sessionID: string): Promise<void>
  remove(sessionID: string): Promise<void>
  listAgents(): Promise<{ id: string; description?: string; mode?: string }[]>
  listAllAgents(): Promise<{ id: string; description?: string; mode?: string }[]>
  switchAgent?(sessionID: string, agent: string): Promise<void>
  switchModel?(sessionID: string, model: ModelRef): Promise<void>
}

export function usageOf(info: { cost?: number; tokens?: { input?: number; output?: number } }): Usage {
  return {
    costUSD: info.cost ?? 0,
    tokens: (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0),
  }
}

export function createRuntime(ctx: Plugin.Context): ArenaRuntime {
  return {
    async createSession(input) {
      const created = await ctx.session.create({
        title: input.title,
        agent: input.agent,
        parentID: input.parentID,
        model: input.model,
        location: input.location,
        metadata: input.metadata,
        permissions: input.permissions,
      })
      return created.id
    },

    async prompt(sessionID, text, options) {
      await ctx.session.prompt({
        sessionID,
        text,
        delivery: options?.delivery,
        resume: options?.resume,
        metadata: options?.metadata,
        files: options?.files?.map((file) => ({
          uri: `data:${file.mime};base64,${file.data}`,
          name: file.name,
        })),
      })
    },

    async wait(sessionID, timeoutMs) {
      if (timeoutMs <= 0) {
        // Continuous room: an agent turn has no artificial deadline.
        return ctx.session.wait({ sessionID }).then(() => "idle" as const).catch(() => "error" as const)
      }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve("timeout")
        }, timeoutMs)
      })
      const finished = ctx.session
        .wait({ sessionID }, { signal: controller.signal })
        .then(() => "idle" as const)
        .catch(() => "error" as const)
      try {
        return await Promise.race([finished, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    async finalText(sessionID) {
      const messages = await ctx.session.context({ sessionID })
      return finalAssistantText(messages)
    },

    async contextMessages(sessionID) {
      return ctx.session.context({ sessionID })
    },

    async usage(sessionID) {
      const info = await ctx.session.get({ sessionID })
      return usageOf(info)
    },

    async info(sessionID) {
      const info = await ctx.session.get({ sessionID })
      return {
        id: info.id,
        agent: info.agent,
        model: info.model,
        cost: info.cost ?? 0,
        tokens: { input: info.tokens.input, output: info.tokens.output },
        metadata: info.metadata as Record<string, unknown> | undefined,
        outcome: info.outcome,
        parentID: (info as { parentID?: string }).parentID,
        updatedAt: (info as { time?: { updated?: number } }).time?.updated,
      }
    },

    async inject(sessionID, key, value) {
      await ctx.session.instructions.entry.put({ sessionID, key, value })
    },

    async synthetic(sessionID, text, options) {
      await ctx.session.synthetic({
        sessionID,
        text,
        delivery: options?.delivery,
        resume: options?.resume,
        metadata: options?.metadata,
      })
    },

    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID, resume: false })
    },

    async remove(sessionID) {
      await ctx.session.remove({ sessionID })
    },

    async listAgents() {
      const output = await ctx.agent.list()
      const agents = output.data ?? []
      return agents
        .filter((agent) => !agent.hidden)
        .map((agent) => ({ id: agent.id, description: agent.description, mode: agent.mode }))
    },
    async listAllAgents() {
      const output = await ctx.agent.list()
      const agents = output.data ?? []
      return agents.map((agent) => ({ id: agent.id, description: agent.description, mode: agent.mode }))
    },
    async switchAgent(sessionID, agent) {
      await ctx.session.switchAgent({ sessionID, agent })
    },
    async switchModel(sessionID, model) {
      await ctx.session.switchModel({ sessionID, model })
    },
  }
}
