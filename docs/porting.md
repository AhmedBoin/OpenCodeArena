# Porting Arena to another harness

The arena has two boundaries:

```
src/core/        field state, inbox, gate, knowledge   no host imports, no globals, no clock
src/field/       roster, prompts, FieldRun driver      host access only through FieldDeps
src/service.ts   rooms, sessions, storage, hooks       host access only through HostPort/ServiceDeps
src/host/        adapter for one harness               translate HostPort to the plugin API
```

Nothing in `core/`, `field/` or `service.ts` imports `@opencode/*`. The only file
that knows OpenCode is `src/host/opencode.ts` (plus the thin `plugin.ts` entry,
which the harness loads).

## What a harness must provide

Implement `HostPort` from `src/host/port.ts` and the runtime it carries:

| Member | Used for | Required |
|---|---|---|
| `runtime.createSession(input)` | named agent and referee sessions | yes |
| `runtime.prompt(id, text, opts)` | kickoff, inbox batches, orders, gate prompts | yes |
| `runtime.wait(id, timeoutMs)` | knowing a step ended | yes |
| `runtime.finalText(id)` | reading a referee or falsifier answer | yes |
| `runtime.usage(id)` | the step budget | yes |
| `runtime.info(id)` | detecting a session that vanished | yes |
| `runtime.interrupt(id)` | stop, accept, timeout | yes |
| `runtime.synthetic(id, text, opts)` | room messages into an agent's transcript | yes |
| `runtime.listAgents()` | validating crew and referee agents | yes |
| `agents.list()` | plan preview | yes |
| `storage.get/set(key, value)` | rooms and `arena:*` state | yes |
| `tools.register(specs)` | `arena`, `arena_bus`, `arena_spawn` | yes |
| `hooks.onContext(cb)` | typing + status line; field agents get no digest | optional |
| `hooks.onIdle(cb)` | clearing typing and flushing the inbox | optional |
| `rpc.register(spec, handlers)` | panel ↔ server | optional |
| `capabilities` | let the arena degrade | yes |

Optional members are declared in `capabilities`. When `rpc` is false the field
runs tools-only; when `idleHook` is false the inbox flush falls back to the 1.5 s
tick; when `panel` is false the GUI bundle is simply not loaded.

### The safe-point contract

The driver assumes one thing from the host: a prompt with
`delivery: "steer"` is delivered at the agent's next safe point, not in the
middle of a tool call, and an idle session can be woken by a prompt. If a harness
cannot do that, implement `steer` as a queue behind the current step. The field
still works, it is just less immediate. Peer messages never rely on this: they
wait in the inbox until the driver sees the step end.

## Writing an adapter

1. Copy `src/host/opencode.ts` to `src/host/<name>.ts`.
2. Implement `create<Name>Host(ctx): HostPort`.
3. Map the host's session API onto `ArenaRuntime` (`src/runtime.ts`) — it is
   already host-neutral.
4. Report `capabilities` from what the context actually exposes, not from
   assumptions: `typeof ctx.x?.y === "function"`.
5. Point the plugin entry at your factory. Everything else stays unchanged.

```ts
import { createMyHost } from "./host/my-harness.ts"

export default Plugin.define({
  id: "arena",
  async setup(ctx) {
    const host = createMyHost(ctx)
    // service, tools, hooks, rpc as in src/plugin.ts
  },
})
```

## Version safety

- Capability flags are detected per load, so a newer host that removed a hook
  degrades instead of crashing.
- The service cache (`globalThis.__opencodeArenaServices`) only reuses an
  instance that implements `SERVICE_SURFACE` from `src/plugin.ts`; a stale
  instance from an older bundle is retired and rebuilt. Add every new
  host-facing method to that list.
- Persisted keys: `arena:field/<runID>`, `arena:field/meta/<runID>`,
  `arena:field/latest/<sessionID>`, `arena:field/sessions/<runID>`,
  `arena:field/bind/<sessionID>`, and `arena/room:<sessionID>`. Unknown or
  unreadable state is marked interrupted, never thrown.

## What stays harness-specific

Only three things: the plugin entry file, the GUI bundle (a panel API), and the
adapter. The field state, inbox, gate, roster, prompts and the driver are shared.
