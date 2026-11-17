import type { PermissionRule } from "./runtime.ts"
import type { Workspace } from "./workspace.ts"

export type SessionRole = "contestant" | "subagent"

export interface SessionBinding {
  runID: string
  label: string
  role: SessionRole
  depth: number
  workspace?: Workspace
}

export function permissionRules(allowNetwork: boolean, allowEdit: boolean, restricted = false): PermissionRule[] {
  const rules: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "arena", resource: "*", effect: "deny" },
  ]
  if (!allowEdit) rules.push({ action: "edit", resource: "*", effect: "deny" })
  if (restricted) {
    // A field seat's helper is a read/research subagent, not a second worker.
    // It may read and search; it may not mutate the tree, launch a process,
    // start another subagent, or drive a browser.
    for (const action of [
      "bash",
      "shell",
      "write",
      "patch",
      "apply",
      "multiedit",
      "task",
      "subagent",
      "arena_bus",
      "arena_fs",
      "arena_git",
      "arena_exec",
      "arena_job",
      "arena_spawn",
      "browser",
    ]) {
      rules.push({ action, resource: "*", effect: "deny" })
    }
  }
  // Network access is never denied. `allowNetwork` is kept in the signature for
  // call compatibility; a field may fetch any URL its brief names.
  void allowNetwork
  return rules
}
