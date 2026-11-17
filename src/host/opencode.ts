import type { Plugin } from "@opencode/plugin"
import { createRuntime } from "../runtime.ts"
import type { CommandSpec, Disposable, HostCapabilities, HostPort, ToolSpec } from "./port.ts"

/**
 * OpenCode adapter. It maps the port onto the public plugin context and adds
 * no arena behaviour. When a newer OpenCode changes a hook or an RPC, only this
 * file changes.
 */
export function createOpenCodeHost(ctx: Plugin.Context, options: { panel?: boolean } = {}): HostPort {
  const runtime = createRuntime(ctx)
  const rpc = (ctx as unknown as { rpc?: { register?: unknown } }).rpc
  const hasHook = typeof (ctx.session as unknown as { hook?: unknown }).hook === "function"
  const hasToolHook = typeof (ctx.tool as unknown as { hook?: unknown }).hook === "function"
  const hasCommands = typeof (ctx.command as unknown as { transform?: unknown })?.transform === "function"

  const capabilities: HostCapabilities = {
    panel: options.panel !== false,
    rpc: typeof rpc?.register === "function",
    contextHook: hasHook,
    idleHook: hasHook,
    toolGuard: hasToolHook,
    subagentTool: true,
    commands: hasCommands,
  }

  const host: HostPort = {
    id: "opencode",
    version: (ctx as unknown as { app?: { version?: string } }).app?.version ?? "unknown",
    capabilities,
    runtime,
    agents: {
      list: () => runtime.listAgents(),
      listAll: () => runtime.listAllAgents(),
    },
    storage: {
      get: async (key) => {
        const value = await ctx.storage.get(key)
        if (typeof value === "string") return value
        if (value === undefined || value === null) return undefined
        return String(value)
      },
      set: (key, value) => ctx.storage.set(key, value),
    },
    tools: {
      register(specs: ToolSpec[]): Promise<Disposable> {
        return ctx.tool.transform((editor) => {
          for (const spec of specs) (editor as unknown as { add(tool: unknown): void }).add(spec)
        })
      },
    },
    commands: hasCommands
      ? {
          register(specs: CommandSpec[]): Promise<Disposable> {
            return ctx.command.transform((editor) => {
              for (const spec of specs) {
                editor.add({
                  name: spec.name,
                  description: spec.description,
                  execute: (input) =>
                    spec.execute({ sessionID: input.sessionID, text: input.prompt.text }),
                })
              }
            }) as unknown as Promise<Disposable>
          },
        }
      : undefined,
    hooks: {
      onContext: (callback) => ctx.session.hook("context", callback as never) as unknown as Promise<Disposable>,
      onIdle: (callback) =>
        ctx.session.hook("experimental.idle" as never, callback as never) as unknown as Promise<Disposable>,
      onToolBefore: (callback) =>
        (ctx.tool as unknown as {
          hook: (name: string, callback: unknown) => Promise<Disposable>
        }).hook("execute.before", callback),
    },
  }

  if (capabilities.rpc && rpc) {
    return {
      ...host,
      rpc: {
        register(spec, handlers) {
          return (rpc as { register: (spec: unknown, handlers: unknown) => Promise<Disposable> }).register(spec, handlers)
        },
      },
    }
  }
  return host
}
