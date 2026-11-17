/** Pull one JSON value out of a model answer, fences and prose included. */
export function extractJSON(text: string): unknown | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.search(/[[{]/)
  if (start < 0) return undefined
  const open = body[start] as "{" | "["
  const close = open === "{" ? "}" : "]"
  const end = body.lastIndexOf(close)
  if (end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}
