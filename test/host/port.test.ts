import { describe, expect, test } from "bun:test"
import { createOpenCodeHost } from "../../src/host/opencode.ts"

function fakeCtx(options: { rpc?: boolean } = {}) {
  const calls: string[] = []
  const added: string[] = []
  const commands: { name: string; description: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }[] = []
  const hookNames: string[] = []
  let toolHook: ((event: { tool: string; sessionID: string; agent: string }) => void) | undefined
  const ctx = {
    app: { version: "2.2.7" },
    session: {
      create: async (input: { agent: string }) => {
        calls.push(`create:${input.agent}`)
        return { id: "ses_child" }
      },
      prompt: async (input: { sessionID: string; delivery?: string }) => {
        calls.push(`prompt:${input.sessionID}:${input.delivery}`)
      },
      wait: async () => undefined,
      context: async () => [],
      get: async () => ({ id: "ses_child", agent: "build", cost: 0.01, tokens: { input: 10, output: 5 }, outcome: "succeeded" }),
      interrupt: async () => {
        calls.push("interrupt")
      },
      remove: async () => {
        calls.push("remove")
      },
      synthetic: async () => undefined,
      hook: async (name: string) => {
        hookNames.push(name)
        return { dispose: async () => undefined }
      },
      instructions: { entry: { put: async () => undefined } },
    },
    agent: {
      list: async () => ({
        data: [
          { id: "build", description: "build", mode: "primary", hidden: false },
          { id: "secret", description: "hidden", mode: "subagent", hidden: true },
        ],
      }),
    },
    storage: { get: async () => undefined, set: async () => undefined },
    tool: {
      transform: async (callback: (editor: { add(tool: { name: string }): void }) => void) => {
        callback({ add: (tool) => added.push(tool.name) })
        return { dispose: async () => undefined }
      },
      hook: async (name: string, callback: typeof toolHook) => {
        hookNames.push(name)
        toolHook = callback
        return { dispose: async () => undefined }
      },
    },
    command: {
      transform: async (
        callback: (editor: {
          add: (definition: {
            name: string
            description: string
            execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>
          }) => void
        }) => void,
      ) => {
        callback({ add: (definition) => commands.push(definition) })
        return { dispose: async () => undefined }
      },
    },
    ...(options.rpc === false ? {} : { rpc: { register: async () => ({ dispose: async () => undefined }) } }),
  }
  return { ctx, calls, added, commands, hookNames, toolHook: () => toolHook }
}

describe("opencode host adapter", () => {
  test("reports capabilities from what the context actually exposes", () => {
    const withRpc = createOpenCodeHost(fakeCtx().ctx as never)
    expect(withRpc.capabilities.rpc).toBe(true)
    expect(withRpc.capabilities.panel).toBe(true)
    expect(withRpc.capabilities.contextHook).toBe(true)

    const withoutRpc = createOpenCodeHost(fakeCtx({ rpc: false }).ctx as never)
    expect(withoutRpc.capabilities.rpc).toBe(false)
    expect(withoutRpc.rpc).toBeUndefined()
  })

  test("maps the runtime session calls", async () => {
    const { ctx, calls } = fakeCtx()
    const host = createOpenCodeHost(ctx as never)
    const id = await host.runtime.createSession({ title: "C1", agent: "build", parentID: "ses_parent" })
    expect(id).toBe("ses_child")
    await host.runtime.prompt(id, "go", { delivery: "steer" })
    const info = await host.runtime.info(id)
    expect(info.outcome).toBe("succeeded")
    await host.runtime.interrupt(id)
    await host.runtime.remove(id)
    expect(calls).toEqual(["create:build", "prompt:ses_child:steer", "interrupt", "remove"])
  })

  test("lists visible and all agents", async () => {
    const host = createOpenCodeHost(fakeCtx().ctx as never)
    expect((await host.agents.list()).map((agent) => agent.id)).toEqual(["build"])
    expect((await host.agents.listAll()).map((agent) => agent.id)).toEqual(["build", "secret"])
  })

  test("registers tools through the host transform", async () => {
    const { ctx, added } = fakeCtx()
    const host = createOpenCodeHost(ctx as never)
    await host.tools.register([
      { name: "arena", description: "x", input: {}, execute: async () => undefined },
      { name: "arena_bus", description: "y", input: {}, execute: async () => undefined },
    ])
    expect(added).toEqual(["arena", "arena_bus"])
  })

  test("registers slash commands and passes the argument text", async () => {
    const { ctx, commands } = fakeCtx()
    const host = createOpenCodeHost(ctx as never)
    expect(host.capabilities.commands).toBe(true)
    const seen: { sessionID: string; text: string }[] = []
    await host.commands!.register([
      {
        name: "arena",
        description: "start",
        execute: async (input) => {
          seen.push(input)
        },
      },
    ])
    expect(commands.map((command) => command.name)).toEqual(["arena"])
    await commands[0]!.execute({ sessionID: "ses_main", prompt: { text: "solve this problem" } })
    expect(seen).toEqual([{ sessionID: "ses_main", text: "solve this problem" }])
  })

  test("forwards the context and idle hooks", async () => {
    const { ctx, hookNames } = fakeCtx()
    const host = createOpenCodeHost(ctx as never)
    await host.hooks.onContext(() => undefined)
    await host.hooks.onIdle(() => undefined)
    expect(hookNames).toEqual(["context", "experimental.idle"])
  })

  test("forwards the tool guard and reports it", async () => {
    const { ctx, hookNames, toolHook } = fakeCtx()
    const host = createOpenCodeHost(ctx as never)
    expect(host.capabilities.toolGuard).toBe(true)
    await host.hooks.onToolBefore?.((event) => {
      if (event.tool === "shell") throw new Error("blocked")
    })
    expect(hookNames).toContain("execute.before")
    expect(() => toolHook()?.({ tool: "shell", sessionID: "ses_parent", agent: "build" })).toThrow("blocked")
  })
})
