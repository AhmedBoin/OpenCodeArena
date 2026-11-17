interface TextPart {
  type: "text"
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function textParts(message: Record<string, unknown>): string[] {
  if (message.type !== "assistant" || !Array.isArray(message.content)) return []
  const parts: string[] = []
  for (const part of message.content) {
    if (!isRecord(part)) continue
    if (part.type !== "text") continue
    const text = (part as unknown as TextPart).text
    if (typeof text === "string" && text.trim().length > 0) parts.push(text)
  }
  return parts
}

/**
 * Read the answer from a finished session: the text of its last assistant
 * message. Tool calls and reasoning parts are ignored, because the arena only
 * scores what the competitor asserts in prose.
 */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message)) continue
    if (message.type !== "assistant") continue
    return textParts(message).join("\n\n").trim()
  }
  return ""
}

export function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
