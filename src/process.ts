import { spawn } from "node:child_process"

/**
 * Kill a process and its descendants.
 *
 * `child.kill()` only signals the shell that Node started. On Windows a shell
 * command that launches python, a debugger or a GUI leaves that child alive;
 * the child keeps the stdio pipes open, so `close` never fires and the Arena
 * run lock is held for the rest of the field.
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process is already gone.
  }
}
