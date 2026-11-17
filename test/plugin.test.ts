import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin.ts"
import { resetSeals } from "../src/seal.ts"
import type { ArenaService } from "../src/service.ts"

interface Tool {
  name: string
  description: string
  options?: { codemode?: boolean }
  execute: (
    input: unknown,
    context: { sessionID: string; signal: AbortSignal; progress: () => Promise<void> },
  ) => Promise<{ content?: unknown; metadata?: unknown }>
}

type Shared = { __opencodeArenaServices?: Map<string, unknown> }

function resetCache(): void {
  delete (globalThis as Shared).__opencodeArenaServices
  resetSeals()
}

function cacheKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function cached(root: string): ArenaService {
  return (globalThis as Shared).__opencodeArenaServices?.get(cacheKey(root)) as ArenaService
}

function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (condition()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error("condition timed out"))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function mockContext() {
  const tools: Tool[] = []
  const sessions = new Map<string, { agent: string; metadata?: Record<string, unknown> }>()
  const lastPrompt = new Map<string, string>()
  const prompts: { sessionID: string; text: string }[] = []
  const synthetics: string[] = []
  let syntheticHangs = false
  const commands: { name: string; description: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }[] = []
  const store = new Map<string, string>()
  const hooks: { name: string; callback: (event: { sessionID: string; system: { type: string; text: string }[] }) => void }[] = []
  let count = 0

  const answerFor = (text: string): string => {
    if (text.includes("You are the Foreman")) return '{"action":"continue"}'
    if (text.includes('"falsified"')) return '{"falsified":false,"reason":"checked the claim"}'
    return "ok"
  }

  const ctx = {
    options: {},
    location: { directory: process.cwd(), project: { id: "p", directory: process.cwd(), canonical: process.cwd() } },
    agent: {
      list: async () => ({
        data: [
          { id: "build", name: "Build", description: "build", mode: "primary", hidden: false },
          { id: "plan", name: "Plan", description: "plan", mode: "primary", hidden: false },
          { id: "uncensored", name: "Uncensored", description: "uncensored", mode: "subagent", hidden: false },
        ],
      }),
    },
    session: {
      create: async (input: { agent: string; metadata?: Record<string, unknown> }) => {
        const id = `ses_${++count}`
        sessions.set(id, { agent: input.agent, metadata: input.metadata })
        return { id }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text })
        lastPrompt.set(input.sessionID, input.text)
      },
      wait: async () => undefined,
      context: async (input: { sessionID: string }) => {
        const text = answerFor(lastPrompt.get(input.sessionID) ?? "")
        return [{ type: "assistant", content: [{ type: "text", text }] }]
      },
      get: async (input: { sessionID: string }) => {
        const session = sessions.get(input.sessionID)
        return {
          id: input.sessionID,
          agent: session?.agent ?? "build",
          model: undefined,
          cost: 0.01,
          tokens: { input: 1000, output: 100 },
          metadata: session?.metadata,
          outcome: "succeeded",
        }
      },
      interrupt: async () => undefined,
      remove: async () => undefined,
      synthetic: async (input: { text: string }) => {
        synthetics.push(input.text)
        if (syntheticHangs) await new Promise<void>(() => undefined)
      },
      instructions: { entry: { put: async () => undefined } },
      hook: async (name: string, callback: (event: { sessionID: string; system: { type: string; text: string }[] }) => void) => {
        hooks.push({ name, callback })
        return { dispose: async () => undefined }
      },
    },
    tool: {
      list: async () => [],
      transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({ add: (tool: Tool) => tools.push(tool) })
        return { dispose: async () => undefined }
      },
    },
    command: {
      list: async () => ({ data: commands }),
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
      reload: async () => undefined,
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: string) => {
        store.set(key, value)
      },
    },
  }
  return {
    ctx,
    tools,
    commands,
    prompts,
    synthetics,
    store,
    hooks,
    sessions,
    setSyntheticHangs: (value: boolean) => {
      syntheticHangs = value
    },
  }
}

function call(tools: Tool[], input: Record<string, unknown>, sessionID = "main") {
  const arena = tools.find((tool) => tool.name === "arena") as Tool
  return arena.execute(input, { sessionID, signal: new AbortController().signal, progress: async () => undefined })
}

describe("arena plugin", () => {
  test("registers the Arena tools and plans a field without starting", async () => {
    resetCache()
    const { ctx, tools } = mockContext()
    await plugin.setup(ctx as never)
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "arena",
      "arena_bus",
      "arena_exec",
      "arena_fs",
      "arena_git",
      "arena_job",
      "arena_spawn",
    ])
    // Field seats must see the Arena tools as callable functions. When they
    // are code-mode-only, a seat has no way to reach the bus or its workspace.
    expect(tools.every((tool) => tool.options?.codemode === false)).toBe(true)
    const result = await call(tools, { action: "plan", objective: "Fix the duplicate webhook order bug", crew: [{ name: "Ada", role: "Builder", brief: "ships working code" }, { name: "Hypatia", role: "Analyst", brief: "maps the system" }] })
    expect(String(result.content)).toContain("Plan: field")
    expect(String(result.content)).toContain("Available agents: build, plan, uncensored")
  })

  test("starts a named field and reports it", async () => {
    resetCache()
    const { ctx, tools, prompts } = mockContext()
    await plugin.setup(ctx as never)
    const started = await call(tools, {
      action: "start",
      objective: "Fix the duplicate webhook order bug",
      crew: [{ name: "Ada", role: "Builder", brief: "ships working code" }, { name: "Hypatia", role: "Analyst", brief: "maps the system" }],
      maxTurns: 3,
    })
    const text = String(started.content)
    expect(text).toContain("field started")
    expect(text).toContain("Ada")
    expect(text).toContain("Vera")
    await until(() => prompts.length >= 2)
    expect(prompts[0]?.text).toContain("The Arena is a live room")
    const status = await call(tools, { action: "status" })
    expect(String(status.content)).toContain("field")
  })

  test("/arena starts a field directly without a coordinator planning turn", async () => {
    resetCache()
    const { ctx, commands, prompts, synthetics } = mockContext()
    await plugin.setup(ctx as never)
    expect(commands.map((command) => command.name)).toContain("arena")
    await commands.find((command) => command.name === "arena")!.execute({
      sessionID: "main",
      prompt: { text: "/arena Fix the duplicate webhook order bug without changing the public API" },
    })
    const service = cached(process.cwd())
    expect(service.fields.size).toBe(1)
    // The command is echoed as a real user row in the main chat; the field
    // itself is not a coordinator planning turn.
    expect(prompts.filter((prompt) => prompt.sessionID === "main")).toHaveLength(1)
    expect(prompts.some((prompt) => prompt.sessionID === "main" && prompt.text.includes("/arena Fix the duplicate"))).toBe(true)
    expect(synthetics.at(-1)).toContain("agents")
    expect(synthetics.at(-1)).toContain("Follow it in the Arena tab")
    const room = await service.roomSnapshot("main")
    expect(room.title).toContain("duplicate webhook order bug")
  })

  test("/arena returns before the queued start notice is delivered", async () => {
    resetCache()
    const { ctx, commands, setSyntheticHangs } = mockContext()
    setSyntheticHangs(true)
    await plugin.setup(ctx as never)
    const command = commands.find((entry) => entry.name === "arena")!
    const outcome = await Promise.race([
      command
        .execute({
          sessionID: "main",
          prompt: { text: "/arena Add login, add audit logging, add rate limiting" },
        })
        .then(() => "returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
    ])
    expect(outcome).toBe("returned")
    expect((cached(process.cwd()) as ArenaService).fields.size).toBe(1)
  })

  test("an agent posts a small dead end that appears in the room", async () => {
    resetCache()
    const { ctx, tools } = mockContext()
    await plugin.setup(ctx as never)
    const started = await call(tools, { action: "start", objective: "Fix the duplicate webhook order bug", crew: [{ name: "Ada", role: "Builder", brief: "ships working code" }, { name: "Hypatia", role: "Analyst", brief: "maps the system" }] })
    const runID = /Arena (\w+) field started/.exec(String(started.content))?.[1] as string
    const service = cached(process.cwd())
    const ada = (service.fields.get(runID) as unknown as { snapshot: { members: { sessionID: string }[] } }).snapshot
      .members[0]!.sessionID
    const bus = tools.find((tool) => tool.name === "arena_bus") as Tool
    const posted = await bus.execute(
      { action: "post", kind: "dead-end", text: "induction fails at the boundary" },
      { sessionID: ada, signal: new AbortController().signal, progress: async () => undefined },
    )
    expect(String(posted.content)).toContain("Posted")
    const room = await service.roomSnapshot("main")
    expect(room.messages.some((message) => message.text.includes("induction fails at the boundary"))).toBe(true)
  })

  test("a long finding is kept up to the structured limit", async () => {
    resetCache()
    const { ctx, tools } = mockContext()
    await plugin.setup(ctx as never)
    const started = await call(tools, { action: "start", objective: "Fix the duplicate webhook order bug", crew: [{ name: "Ada", role: "Builder", brief: "ships working code" }, { name: "Hypatia", role: "Analyst", brief: "maps the system" }] })
    const runID = /Arena (\w+) field started/.exec(String(started.content))?.[1] as string
    const service = cached(process.cwd())
    const ada = (service.fields.get(runID) as unknown as { snapshot: { members: { sessionID: string }[] } }).snapshot
      .members[0]!.sessionID
    const bus = tools.find((tool) => tool.name === "arena_bus") as Tool
    const posted = await bus.execute(
      { action: "post", kind: "finding", text: "x".repeat(1_000) },
      { sessionID: ada, signal: new AbortController().signal, progress: async () => undefined },
    )
    expect(String(posted.content)).toContain("Posted")
    const room = await service.roomSnapshot("main")
    const finding = room.messages.find((message) => message.kind === "finding")
    expect(finding?.text.length).toBe(1_000)
    expect(finding?.meta?.detail).toBeUndefined()
  })

  test("finish posts a claim and the gate accepts it", async () => {
    resetCache()
    const { ctx, tools } = mockContext()
    await plugin.setup(ctx as never)
    const started = await call(tools, { action: "start", objective: "Fix the duplicate webhook order bug", crew: [{ name: "Ada", role: "Builder", brief: "ships working code" }, { name: "Hypatia", role: "Analyst", brief: "maps the system" }] })
    const runID = /Arena (\w+) field started/.exec(String(started.content))?.[1] as string
    const service = cached(process.cwd())
    const ada = (service.fields.get(runID) as unknown as { snapshot: { members: { sessionID: string }[] } }).snapshot
      .members[0]!.sessionID
    const result = await call(
      tools,
      { action: "finish", message: "the case holds", goal: "bun test -> 0 fail" },
      ada,
    )
    expect(String(result.content)).toContain("claim")
    const room = await service.roomSnapshot("main")
    expect(room.messages.some((message) => message.kind === "verdict" && message.text.includes("accepted"))).toBe(true)
  })

  test("unknown input returns a readable error instead of throwing", async () => {
    resetCache()
    const { ctx, tools } = mockContext()
    await plugin.setup(ctx as never)
    const result = await call(tools, { action: "start", objective: "tiny" })
    expect(String(result.content)).toContain("Arena error")
  })

  test("fires the typing hooks without throwing", async () => {
    resetCache()
    const { ctx, hooks } = mockContext()
    await plugin.setup(ctx as never)
    const context = hooks.find((hook) => hook.name === "context")
    const idle = hooks.find((hook) => hook.name === "experimental.idle")
    expect(context && idle).toBeTruthy()
    expect(() => context!.callback({ sessionID: "ses_typing", system: [] })).not.toThrow()
    expect(() => idle!.callback({ sessionID: "ses_typing", system: [] })).not.toThrow()
  })

  test("replaces a cached service whose class came from an older build", async () => {
    const root = process.cwd()
    const shared = globalThis as Shared
    const previous = shared.__opencodeArenaServices
    let retired = 0
    class OldBuild {
      statusLineFor() {}
      roomContextFor() {}
      roomSnapshot() {}
      chat() {}
      setTypingBySession() {}
      startArenaRounds() {}
      stopArenaRounds() {}
      arenaRoundsStatus() {}
      roundOverview() {}
      waitForRoomTick() {}
      retire() {
        retired += 1
      }
    }
    shared.__opencodeArenaServices = new Map([[cacheKey(root), new OldBuild()]])
    try {
      const { ctx } = mockContext()
      await plugin.setup(ctx as never)
      expect(retired).toBe(1)
      const rebuilt = cached(root) as unknown as { startField?: unknown; setTypingBySession?: unknown }
      expect(typeof rebuilt.startField).toBe("function")
      expect(typeof rebuilt.setTypingBySession).toBe("function")
    } finally {
      shared.__opencodeArenaServices = previous
    }
  })

  test("replaces a cached service that predates even retire()", async () => {
    const root = process.cwd()
    const shared = globalThis as Shared
    const previous = shared.__opencodeArenaServices
    shared.__opencodeArenaServices = new Map([[cacheKey(root), {}]])
    try {
      const { ctx, hooks } = mockContext()
      await expect(plugin.setup(ctx as never)).resolves.toBeTruthy()
      const rebuilt = cached(root) as unknown as { startField?: unknown }
      expect(typeof rebuilt.startField).toBe("function")
      const context = hooks.find((hook) => hook.name === "context")
      expect(() => context?.callback({ sessionID: "ses_typing", system: [] })).not.toThrow()
    } finally {
      shared.__opencodeArenaServices = previous
    }
  })

  test("uses the project directory, not a seat worktree, as the service key", async () => {
    resetCache()
    const { ctx } = mockContext()
    ctx.location.directory = join(tmpdir(), "arena", "run", "Ada")
    await plugin.setup(ctx as never)
    expect(cached(process.cwd())).toBeTruthy()
  })

  test("shares one service across repeated loads of the same build", async () => {
    resetCache()
    const root = process.cwd()
    const first = mockContext()
    await plugin.setup(first.ctx as never)
    const instance = cached(root)
    expect(instance).toBeTruthy()
    const second = mockContext()
    await plugin.setup(second.ctx as never)
    expect(cached(root)).toBe(instance)
  })
})
