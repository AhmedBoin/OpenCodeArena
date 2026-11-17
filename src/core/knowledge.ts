/**
 * Arena knowledge — what an agent should see from the shared room, and in what
 * order. Pure data; the host decides where the text goes.
 */

export type KnowledgeKind =
  | "order"
  | "goal"
  | "question"
  | "answer"
  | "request"
  | "dead-end"
  | "claim"
  | "attack"
  | "finding"
  | "intent"
  | "handoff"
  | "lesson"
  | "status"
  | "chat"
  | "lifecycle"
  | "verdict"

export interface KnowledgeItem {
  id: string
  author: string
  kind: KnowledgeKind
  text: string
  at: number
  to: "all" | string[]
  private?: boolean
  replyTo?: string
}

export interface KnowledgeView {
  seen: string[]
  kept: string[]
  dropped: string[]
}

export const LIFE = "lifecycle"

export function emptyView(): KnowledgeView {
  return { seen: [], kept: [], dropped: [] }
}

export function markSeen(view: KnowledgeView, ids: string[]): KnowledgeView {
  const seen = [...new Set([...view.seen, ...ids])]
  return { ...view, seen }
}

export function keepItem(view: KnowledgeView, id: string): KnowledgeView {
  return {
    seen: [...new Set([...view.seen, id])],
    kept: [...new Set([...view.kept, id])],
    dropped: view.dropped.filter((value) => value !== id),
  }
}

export function dropItem(view: KnowledgeView, id: string): KnowledgeView {
  return {
    seen: [...new Set([...view.seen, id])],
    kept: view.kept.filter((value) => value !== id),
    dropped: [...new Set([...view.dropped, id])],
  }
}

function addressedTo(item: KnowledgeItem, me: string): boolean {
  return item.to === "all" || item.to.includes(me)
}

export function visibleTo(item: KnowledgeItem, view: KnowledgeView, me: string): boolean {
  if (item.author === me) return false
  const kept = view.kept.includes(item.id)
  if (view.dropped.includes(item.id) && !kept) return false
  if (item.private && !addressedTo(item, me)) return false
  return true
}

const BASE: Record<KnowledgeKind, number> = {
  order: 100,
  goal: 95,
  claim: 90,
  verdict: 85,
  question: 80,
  answer: 80,
  request: 80,
  "dead-end": 75,
  attack: 70,
  intent: 60,
  lesson: 55,
  finding: 50,
  handoff: 45,
  status: 30,
  chat: 20,
  lifecycle: 10,
}

/** Higher is more worth injecting; -1 means hidden. */
export function relevance(item: KnowledgeItem, view: KnowledgeView, me: string): number {
  if (!visibleTo(item, view, me)) return -1
  const base = BASE[item.kind] ?? 10
  const directed = addressedTo(item, me) && item.to !== "all" ? 5 : 0
  const kept = view.kept.includes(item.id) ? 20 : 0
  return base + directed + kept
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Collapse repeated text, keeping the newest copy. Order is newest first. */
export function dedupe(items: readonly KnowledgeItem[]): KnowledgeItem[] {
  const byText = new Map<string, KnowledgeItem>()
  for (const item of items) {
    const key = normalize(item.text)
    const current = byText.get(key)
    if (!current || item.at >= current.at) byText.set(key, item)
  }
  return [...byText.values()].sort((left, right) => right.at - left.at)
}

export interface DigestOptions {
  budget?: number
  maxItems?: number
  lineChars?: number
}

/**
 * The block an agent receives in its prompt: relevant, deduplicated, budgeted.
 * Own messages never appear; dropped ids never appear.
 */
export function digest(items: readonly KnowledgeItem[], view: KnowledgeView, me: string, options: DigestOptions = {}): string {
  const budget = options.budget ?? 1800
  const maxItems = options.maxItems ?? 12
  const lineChars = options.lineChars ?? 220

  const ranked = dedupe(items)
    .filter((item) => visibleTo(item, view, me))
    .map((item) => ({ item, score: relevance(item, view, me) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || right.item.at - left.item.at)
    .slice(0, maxItems)

  const lines: string[] = []
  let used = 0
  for (const { item } of ranked) {
    const prefix = item.kind === "order" ? "ORDER " : ""
    const body = item.text.replace(/\s+/g, " ").trim().slice(0, lineChars)
    const line = `[${item.id}] ${prefix}${item.author} (${item.kind}): ${body}`
    if (lines.length > 0 && used + line.length + 1 > budget) break
    if (lines.length === 0 && line.length > budget) {
      lines.push(line.slice(0, budget))
      used = budget
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join("\n")
}
