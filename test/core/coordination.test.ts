import { describe, expect, test } from "bun:test"
import {
  activeIntents,
  answerMention,
  expireIntents,
  expireMentions,
  markMentionDelivered,
  noteIntent,
  noteLesson,
  noteMention,
  openField,
  openMentionFrom,
  openMentionsFor,
  releaseIntent,
} from "../../src/core/field.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "coordinate the parser fix",
  constraints: [],
  successCriteria: ["the parser test passes"],
  nonGoals: [],
}

function field() {
  return openField({
    id: "f1",
    parentSessionID: "p",
    contract,
    members: [
      { label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s1" },
      { label: "Hypatia", agent: "build", stance: STANCES[1]!, sessionID: "s2" },
    ],
    now: 1_000,
    budgetMs: 600_000,
    checkEveryMs: 120_000,
    maxTurns: 30,
    maxForemanTurns: 4,
  })
}

function mention(state = field()) {
  return noteMention(state, {
    id: "m4",
    from: "Ada",
    to: "Hypatia",
    text: "which file owns the parser?",
    at: 1_000,
    replyBy: 61_000,
    requiresReply: true,
    senderWaits: true,
  })
}

describe("coordination state", () => {
  test("a named mention opens exactly one reply obligation", () => {
    const state = mention()
    expect(openMentionsFor(state, "Hypatia", 2_000)).toHaveLength(1)
    expect(openMentionFrom(state, "Ada", 2_000)?.id).toBe("m4")
    expect(state.mentions?.[0]?.status).toBe("open")
  })

  test("an answer closes only the matching open mention", () => {
    const state = mention()
    const answered = answerMention(state, "m4", "m5")
    expect(openMentionsFor(answered, "Hypatia", 2_000)).toHaveLength(0)
    expect(answered.mentions?.[0]?.answeredBy).toBe("m5")
    expect(answerMention(answered, "m4", "m6")).toBe(answered)
  })

  test("an expired mention stays in history but is no longer open", () => {
    const delivered = markMentionDelivered(mention(), "m4", "Hypatia", 2_000, 60_000)
    const expired = expireMentions(delivered, 62_000)
    expect(openMentionsFor(expired, "Hypatia", 62_000)).toHaveLength(0)
    expect(expired.mentions?.[0]?.status).toBe("expired")
    expect(openMentionFrom(expired, "Ada", 62_000)).toBeUndefined()
  })

  test("an undelivered mention does not expire unseen", () => {
    const state = mention()
    const stillOpen = expireMentions(state, 62_000)
    expect(stillOpen.mentions?.[0]?.status).toBe("open")
    expect(stillOpen.mentions?.[0]?.delivery).toBe("pending")
    const delivered = markMentionDelivered(stillOpen, "m4", "Hypatia", 70_000, 60_000)
    expect(delivered.mentions?.[0]?.replyBy).toBe(130_000)
    const expired = expireMentions(delivered, 131_000)
    expect(expired.mentions?.[0]?.status).toBe("expired")
  })

  test("a mention without a sender wait still obliges the target", () => {
    const state = noteMention(field(), {
      id: "m7",
      from: "Ada",
      to: "Hypatia",
      text: "the fixture is already reset",
      at: 1_000,
      replyBy: 61_000,
      requiresReply: true,
      senderWaits: false,
    })
    expect(openMentionsFor(state, "Hypatia", 2_000)).toHaveLength(1)
    expect(openMentionFrom(state, "Ada", 2_000)).toBeUndefined()
  })

  test("an intent lease is active, releasable, and expires", () => {
    const state = noteIntent(field(), {
      id: "m10",
      owner: "Ada",
      area: "parser",
      note: "taking parser",
      at: 1_000,
      expiresAt: 601_000,
    })
    expect(activeIntents(state, 2_000)).toHaveLength(1)
    const released = releaseIntent(state, { owner: "Ada", area: "parser", now: 3_000 })
    expect(activeIntents(released, 4_000)).toHaveLength(0)
    expect(released.intents?.[0]?.status).toBe("released")
    const expired = expireIntents(state, 601_001)
    expect(expired.intents?.[0]?.status).toBe("expired")
  })

  test("a repeated intent updates the same lease instead of duplicating it", () => {
    const first = noteIntent(field(), {
      id: "m10",
      owner: "Ada",
      area: "parser",
      note: "taking parser",
      at: 1_000,
      expiresAt: 601_000,
    })
    const second = noteIntent(first, {
      id: "m11",
      owner: "Ada",
      area: "parser",
      note: "renewing parser",
      at: 2_000,
      expiresAt: 602_000,
    })
    expect(second.intents).toHaveLength(1)
    expect(second.intents?.[0]?.id).toBe("m11")
    expect(second.intents?.[0]?.note).toBe("renewing parser")
  })

  test("lessons are kept once and capped", () => {
    let state = field()
    for (let index = 0; index < 25; index++) {
      state = noteLesson(state, { label: "Ada", text: `lesson ${index}`, at: index })
    }
    state = noteLesson(state, { label: "Ada", text: "lesson 24", at: 30 })
    expect(state.lessons).toHaveLength(20)
    expect(state.lessons?.at(-1)?.text).toBe("lesson 24")
  })
})
