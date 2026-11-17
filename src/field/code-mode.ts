/**
 * Code Mode routing guard.
 *
 * OpenCode can expose plugin tools only inside its `execute` runtime. A field
 * seat still has to reach `arena_bus`, `arena_fs`, `arena_exec` and
 * `arena_job`, so `execute` may run a body that calls those tools. It may not
 * be used as a side door to the host's shell, file or subagent tools.
 *
 * This is a routing check, not a sandbox. The Arena tools themselves enforce
 * the workspace lock, copy-on-write and the session binding.
 */

const ARENA_CODE_TOOLS = new Set(["arena", "arena_bus", "arena_fs", "arena_git", "arena_exec", "arena_job"])

/** The coordinator may inspect and steer the room, but not run the crew's work. */
export const ARENA_CONTROL_TOOLS = new Set(["arena", "arena_bus"])

/**
 * UI-only tools the coordinator may use while a field is live. `deck_progress`
 * paints the plan band; it does not read, write, launch or browse. Blocking it
 * was a usability bug, not a safety boundary.
 */
export const COORDINATOR_UI_CODE_TOOLS = new Set([...ARENA_CONTROL_TOOLS, "deck_progress"])

// `tools.arena_fs`, `tools["arena_fs"]`, and optional chaining variants.
const TOOL_REFERENCE = /\btools\s*\??\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"']+)\2\s*\])/g

// Direct bridges to the host. The tool-name check already rejects the normal
// `tools.shell`/`tools.write` paths; these catch the obvious runtime escapes.
const HOST_ESCAPE =
  /(?:\bchild_process\b|\bBun\s*\.\s*spawn\b|\bDeno\s*\.|\bglobalThis\b|\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\()/

function codeOf(input: unknown): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : ""
  const code = (input as { code?: unknown }).code
  return typeof code === "string" ? code : ""
}

/** True when an `execute` body calls only the allowed Arena tools. */
export function arenaOnlyCode(input: unknown, allowed: ReadonlySet<string> = ARENA_CODE_TOOLS): boolean {
  const code = codeOf(input)
  if (code.trim().length === 0) return false
  if (HOST_ESCAPE.test(code)) return false
  const names: string[] = []
  for (const match of code.matchAll(TOOL_REFERENCE)) {
    names.push(match[1] ?? match[3] ?? "")
  }
  if (names.length === 0) return false
  return names.every((name) => allowed.has(name))
}
