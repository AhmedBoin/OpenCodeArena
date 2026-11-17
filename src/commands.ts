export type RoomCommand = "stop" | "continue"

const STOP =
  /^(?:please\s+)?(?:stop|halt|pause|enough)(?:\s+(?:now|please|everything|all|it|the\s+room|this))?[.!]*$/i
const CONTINUE =
  /^(?:please\s+)?(?:continue|resume|keep\s+going|carry\s+on|go\s+on|proceed|unpause)(?:\s+(?:now|please|all|everyone))?[.!]*$/i

/**
 * A short message in the room can be a command instead of chat. The match is
 * deliberately strict so "stop the retry loop" stays a normal instruction.
 */
export function parseRoomCommand(text: string): RoomCommand | undefined {
  const bare = text.trim().replace(/^[/!]+\s*/, "")
  if (bare.length === 0) return undefined
  if (STOP.test(bare)) return "stop"
  if (CONTINUE.test(bare)) return "continue"
  return undefined
}
