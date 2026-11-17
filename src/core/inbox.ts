/**
 * Per-agent inbox for peer messages. Nothing here reaches a host: the driver
 * decides when to flush a batch into an agent's next turn.
 */

import type { RoomKind } from "../types.ts"

export interface InboxItem {
  id: string
  author: string
  kind: RoomKind
  text: string
  to: string[] | "all"
  at: number
  /** True when the text or the sender addressed this agent by name. */
  mention?: boolean
  /** True when the message was addressed to everyone with @all. */
  mentionAll?: boolean
  /** Absolute time by which a mentioned target should answer. */
  replyBy?: number
  /** The message id that opened the mention, for `replyTo`. */
  fromMessageID?: string
  /** The area or resource this post owns, when it named one. */
  area?: string
  /** The message this post answers, when it used replyTo. */
  replyTo?: string
  /** The experiment this post started or finished. */
  experiment?: string
}

export interface InboxState {
  [label: string]: InboxItem[]
}

export const INBOX_CAP = 24

export function emptyInbox(): InboxState {
  return {}
}

export function enqueue(state: InboxState, label: string, item: InboxItem): InboxState {
  const current = state[label] ?? []
  const next = [...current, item]
  const bounded = next.length > INBOX_CAP ? next.slice(next.length - INBOX_CAP) : next
  return { ...state, [label]: bounded }
}

export function take(state: InboxState, label: string): { items: InboxItem[]; state: InboxState } {
  const items = state[label] ?? []
  const next = { ...state }
  delete next[label]
  return { items, state: next }
}

export function pending(state: InboxState, label: string): number {
  return state[label]?.length ?? 0
}

export function shouldFlush(input: {
  queued: number
  working: boolean
  now: number
  lastActivityAt: number
  debounceMs: number
}): boolean {
  if (input.queued <= 0) return false
  if (input.working) return false
  return input.now - input.lastActivityAt >= input.debounceMs
}

/** The text shown above a batch when messages were dropped at the cap. */
export function omittedLine(count: number): string {
  return count > 0 ? `… ${count} older message(s) omitted\n` : ""
}
