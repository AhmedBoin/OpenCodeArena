import { Plugin } from "@opencode/plugin"
import { COORDINATOR_UI_CODE_TOOLS, arenaOnlyCode } from "./field/code-mode.ts"
import { createOpenCodeHost } from "./host/opencode.ts"
import { ROOM_LABELS } from "./room.ts"
import { ArenaRpc } from "./room-rpc.ts"
import { ArenaService } from "./service.ts"
import { registerArenaTools } from "./tools.ts"
import { WorkspaceManager } from "./workspace.ts"

const EMPTY_BOARD = (): {
  runID: string
  status: string
  objective: string
  members: unknown[]
  posts: number
  deadEnds: number
  claims: number
  elapsedMs: number
  budgetMs: number
} => ({
  runID: "",
  status: "none",
  objective: "",
  members: [],
  posts: 0,
  deadEnds: 0,
  claims: 0,
  elapsedMs: 0,
  budgetMs: 0,
})

const SERVICE_SURFACE = [
  "statusLineFor",
  "roomContextFor",
  "roomSnapshot",
  "chat",
  "setTypingBySession",
  "startField",
  "startFromCommand",
  "stopField",
  "fieldBoard",
  "fieldStatus",
  "isFieldParent",
  "waitForRoomTick",
  "finishParticipant",
] as const

/**
 * A cached service is only safe to share when it was built from this exact
 * source. Comparing the class text catches any change to the service — a new
 * method, a changed body — not just a missing method.
 */
function sameBuild(service: ArenaService): boolean {
  try {
    return (service.constructor as { toString(): string }).toString() === ArenaService.toString()
  } catch {
    return false
  }
}

function implementsSurface(service: ArenaService): boolean {
  if (!sameBuild(service)) return false
  const surface = service as unknown as Record<string, unknown>
  return SERVICE_SURFACE.every((method) => typeof surface[method] === "function")
}

/**
 * Typing is cosmetic: a host that cannot store it must never fail the request.
 */
function setTyping(service: ArenaService, sessionID: string, typing: boolean): void {
  if (typeof service.setTypingBySession !== "function") return
  void service.setTypingBySession(sessionID, typing).catch(() => undefined)
}

export default Plugin.define({
  id: "arena",
  async setup(ctx) {
    if (process.env.ARENA_DEBUG) console.log(`[arena] plugin loaded in OpenCode ${ctx.app.version}`)
    // Everything the arena needs from the host arrives through this port.
    // A different harness implements the same interface; the arena does not change.
    const host = createOpenCodeHost(ctx)
    // The host may load this plugin more than once in one process (one load
    // per request or session). A single service instance per workspace keeps
    // the room, its participants and its writes consistent across those loads.
    //
    // Those loads do not run the same build: the host rebundles the entrypoint
    // on every reload, so the cached instance can come from an older bundle
    // whose class predates methods this bundle calls. Reusing it blindly is
    // what surfaced as "service.setTypingBySession is not a function" inside a
    // live session and failed the request. Reuse an instance only when it
    // implements the surface used here; otherwise retire it, drop it from the
    // cache and build a fresh service from the current source.
    const shared = globalThis as typeof globalThis & {
      __opencodeArenaServices?: Map<string, ArenaService>
      __opencodeArenaPending?: Map<string, Promise<ArenaService>>
    }
    // Field seats run in their own worktrees. OpenCode loads the plugin again
    // for each session location, so keying the service by the worktree creates
    // one Arena driver per seat: duplicate ticks, duplicate notices and
    // conflicting field state. The project directory is the real Arena root;
    // all seats of one project share one service and one driver.
    const root = ctx.location.project?.directory ?? ctx.location.directory
    // Windows can hand back the same directory with different separators or
    // drive-letter case; one key per real directory, one service, one driver.
    const cacheKey = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    const cached = shared.__opencodeArenaServices?.get(cacheKey)
    if (cached && !implementsSurface(cached)) {
      if (process.env.ARENA_DEBUG) console.log("[arena] replacing a service cached by an older build")
      shared.__opencodeArenaServices?.delete(cacheKey)
      // The stale instance predates this file too, so even retire() may be
      // absent: it must never become the next crash while recovering from one.
      if (typeof cached.retire === "function") cached.retire()
    }
    let service = cached && implementsSurface(cached) ? cached : undefined
    if (!service) {
      // The host can load the plugin several times in parallel during startup.
      // Without a shared in-flight promise each load creates its own service and
      // each one resumes the same fields, which duplicates lifecycle and expiry
      // messages. One creator per workspace, everyone else waits for it.
      const pending = shared.__opencodeArenaPending?.get(cacheKey)
      if (pending) {
        service = await pending
      } else {
        const promise = (async () => {
          const created = new ArenaService({
            runtime: host.runtime,
            workspace: new WorkspaceManager(),
            root,
            storage: host.storage,
            synthetic: async (sessionID, text) => {
              await host.runtime.synthetic(sessionID, text)
            },
            parentInfo: async (sessionID) => {
              const info = await host.runtime.info(sessionID)
              return { agent: info.agent, model: info.model }
            },
          })
          await created.init()
          shared.__opencodeArenaServices ??= new Map()
          shared.__opencodeArenaServices.set(cacheKey, created)
          return created
        })()
        shared.__opencodeArenaPending ??= new Map()
        shared.__opencodeArenaPending.set(cacheKey, promise)
        try {
          service = await promise
        } finally {
          shared.__opencodeArenaPending.delete(cacheKey)
        }
      }
    }
    let rpc: { dispose: () => Promise<void> } | undefined
    try {
      if (!host.rpc) throw new Error("RPC not available")
      rpc = await host.rpc.register(ArenaRpc, {
        async snapshot(input) {
          const request = input as { sessionID: string }
          return service.roomSnapshot(request.sessionID)
        },
        async board(input) {
          const request = input as { sessionID: string }
          try {
            return (await service.fieldBoard(request.sessionID)) ?? EMPTY_BOARD()
          } catch (error) {
            console.error("[arena] board rpc failed", error)
            return EMPTY_BOARD()
          }
        },
        async wait(input) {
          const request = input as { sessionID: string; after?: string; timeoutMs?: number }
          try {
            return (
              (await service.waitForRoomTick(request.sessionID, request.after ?? "", request.timeoutMs ?? 15_000)) ??
              EMPTY_BOARD()
            )
          } catch (error) {
            console.error("[arena] wait rpc failed", error)
            return EMPTY_BOARD()
          }
        },
        async send(input) {
          const request = input as {
            sessionID: string
            text: string
            to?: string[] | "all"
            private?: boolean
            attachments?: { name: string; mime: string; data: string }[]
          }
          try {
            const result = await service.chat({
              parentSessionID: request.sessionID,
              callerSessionID: request.sessionID,
              authorSessionID: request.sessionID,
              panel: true,
              authorRole: "user",
              text: request.text,
              to: request.to,
              private: request.private,
              attachments: request.attachments,
            })
            if (typeof result === "string") throw new Error(result)
            // The panel refetches the room through `board`/`snapshot`; echoing a
            // full snapshot here would duplicate it and risk invalid optional keys.
            return { ok: true, message: result.message.id }
          } catch (error) {
            console.error("[arena] send rpc failed", error)
            throw error
          }
        },
      })
    } catch {
      // The room still works through the arena tools if this host has no RPC.
    }
    const tools = await registerArenaTools(host, service)
    let commands: { dispose: () => Promise<void> } | undefined
    try {
      if (host.commands) {
        commands = await host.commands.register([
          {
            name: "arena",
            description:
              "Start or continue an Arena field from the text after /arena. /arena continue <mission> keeps the same crew and history; /arena <mission> starts a new crew. No planning chatter.",
            async execute(input) {
              const command = (input.text ?? "").trim()
              const continuing = /^continue\b/i.test(command)
              // Echo the user's command before any work starts. The old notice
              // was sent only after startField finished (worktree copies can
              // take seconds), so the chat looked frozen until the Arena tab
              // appeared. This is a synthetic row, not a model turn.
              // A command input is not stored as a user message by the host.
              // Put the exact command into the main chat as a real user row
              // (blue), then let the command start the field underneath it.
              void host.runtime
                .prompt(
                  input.sessionID,
                  command.startsWith("/arena") ? command : `/arena ${command}`,
                  {
                    delivery: "steer",
                    resume: false,
                    metadata: { arenaCommand: true, continuing },
                  },
                )
                .catch(() => undefined)
              const result = await service.startFromCommand(input.text, input.sessionID)
              // A successful start is followed by the Arena tab; a refused or
              // incomplete command has no field turn to carry the message, so
              // put that result in the main chat as a user row too.
              const needsChatResult = /^(?:Arena could not|Arena .+ is already|Usage:)/.test(result)
              void (needsChatResult
                ? host.runtime.prompt(input.sessionID, `[arena] ${result}`, {
                    delivery: "steer",
                    resume: false,
                    metadata: { arenaCommand: true, result: true },
                  })
                : host.runtime.synthetic(input.sessionID, `[arena] ${result}`, {
                    delivery: "queue",
                    resume: false,
                  })
              ).catch(() => undefined)
            },
          },
        ])
      }
    } catch {
      // Older hosts without command transforms still have the arena tool.
    }
    let guard: { dispose: () => Promise<void> } | undefined
    try {
      if (host.hooks.onToolBefore) {
        guard = await host.hooks.onToolBefore((event) => {
          if (service.isFieldMember(event.sessionID)) {
            const verdict = service.guardTool(event.sessionID, event.tool, event.input)
            if (!verdict.allowed) {
              throw new Error(verdict.reason ?? "This resource is owned by another Arena agent.")
            }
            return
          }
          if (!service.isFieldParent(event.sessionID)) return
          const name = event.tool.toLowerCase()
          const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name
          if (
            base === "arena" ||
            base === "arena_bus" ||
            base === "question" ||
            base === "ask_user_question" ||
            base === "deck_progress"
          ) {
            return
          }
          // Code Mode routes tool calls through one `execute` tool. Allow it only
          // when the code calls the Arena tools/UI band and nothing that can do work.
          if (base === "execute" && arenaOnlyCode(event.input, COORDINATOR_UI_CODE_TOOLS)) return
          throw new Error(
            "An Arena field is live. You are the coordinator, not a worker. Do not run shell, read, edit, browser or subagent tools. Use arena status/read to inspect the room and arena chat or steer to guide the crew. If the task needs work, name the owner in the room.",
          )
        })
      }
    } catch {
      // A host without the tool guard still gets the repeated coordinator prompt.
    }
    let hook: { dispose: () => Promise<void> } | undefined
    let idleHook: { dispose: () => Promise<void> } | undefined
    try {
      hook = await host.hooks.onContext((event) => {
        for (let index = event.system.length - 1; index >= 0; index--) {
          const part = event.system[index]
          if (part?.type === "text" && (part.text.startsWith("[arena.room]") || part.text.startsWith("[arena.status]"))) {
            event.system.splice(index, 1)
          }
        }
        const line = service.statusLineFor(event.sessionID)
        if (line) {
          event.system.push({
            type: "text",
            text: `[arena.status]\n${line}\nUse the arena tool with action status for details, or action chat to speak in the room.`,
          })
        }
        const room = service.roomContextFor(event.sessionID)
        if (room) {
          event.system.push({
            type: "text",
            text: `[arena.room]\n${room.block}\nReply in the room with arena_bus post; read it with arena_bus read.`,
          })
        }
        setTyping(service, event.sessionID, true)
      })
      idleHook = await host.hooks.onIdle((event) => {
        setTyping(service, event.sessionID, false)
      })
    } catch {
      // Older hosts without these hooks still get the tools and the room.
    }

    return () => {
      void tools.dispose()
      void commands?.dispose()
      void guard?.dispose()
      void hook?.dispose()
      void idleHook?.dispose()
      void rpc?.dispose()
    }
  },
})
