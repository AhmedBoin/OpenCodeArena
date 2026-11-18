/**
 * The key of the live run that should open the Arena tab, or undefined when
 * there is nothing to open. Kept pure so the GUI effect is testable without the
 * desktop host.
 */
export function arenaRunToOpen(input: {
  sessionID: string
  key: string
  watched: string
  field?: { runID?: string; status?: string }
}): string | undefined {
  if (!input.field?.runID || input.key !== input.watched || input.field.status !== "running") return undefined
  return `${input.sessionID}:${input.field.runID}`
}
