/**
 * Host port — the only surface a harness must implement.
 *
 * `core/` and `service.ts` never import a harness. An adapter translates this
 * port to the host's plugin API. Adding a harness means writing one adapter
 * file; the arena does not change.
 */

import type { ArenaRuntime } from "../runtime.ts"

export interface Disposable {
  dispose(): Promise<void>
}

export interface AgentInfo {
  id: string
  description?: string
  mode?: string
}

export interface ToolSpec {
  name: string
  description: string
  input: unknown
  /** Host routing options, for example `codemode: false` for a direct tool. */
  options?: { codemode?: boolean }
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

export interface CommandSpec {
  name: string
  description: string
  /** The text after the slash command, and the session that invoked it. */
  execute(input: { sessionID: string; text: string }): Promise<void>
}

export interface HostCapabilities {
  /** The host can render a side panel for this plugin. */
  panel: boolean
  /** The host exposes an RPC channel the GUI can call. */
  rpc: boolean
  /** A hook fires when a session starts a model request. */
  contextHook: boolean
  /** A hook fires when a session goes idle. */
  idleHook: boolean
  /** A hook can reject a tool call before it executes. */
  toolGuard: boolean
  /** The main session can launch subagent tasks. */
  subagentTool: boolean
  /** The host can register slash commands. */
  commands: boolean
}

export interface HostPort {
  /** Adapter id, for example "opencode". */
  readonly id: string
  readonly version: string
  readonly capabilities: HostCapabilities
  readonly runtime: ArenaRuntime
  readonly agents: { list(): Promise<AgentInfo[]>; listAll(): Promise<AgentInfo[]> }
  readonly storage: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
  }
  readonly tools: { register(specs: ToolSpec[]): Promise<Disposable> }
  readonly commands?: { register(specs: CommandSpec[]): Promise<Disposable> }
  readonly rpc?: {
    register(spec: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>): Promise<Disposable>
  }
  readonly hooks: {
    onContext(callback: (event: { sessionID: string; system: { type: string; text: string }[] }) => void): Promise<Disposable>
    onIdle(callback: (event: { sessionID: string }) => void): Promise<Disposable>
    onToolBefore?(
      callback: (event: { tool: string; sessionID: string; agent: string; input?: unknown }) => void | Promise<void>,
    ): Promise<Disposable>
  }
}
