import { describe, expect, test } from "bun:test"
import { noteIntent, noteLesson, noteMention, openField } from "../../src/core/field.ts"
import {
  boardText,
  inboxPrompt,
  kickoffPrompt,
  parseReferee,
  refereePrompt,
  refereeRole,
  socialBlock,
} from "../../src/field/prompts.ts"
import { FOREMAN_NAME, makeCrew } from "../../src/field/roster.ts"
import { STANCES, type CrewSpec, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Prove the boundary case of the recurrence",
  constraints: ["no guessing"],
  successCriteria: ["the case is settled with evidence"],
  nonGoals: [],
}

const crew: CrewSpec[] = [
  { name: "Ada", role: "Builder", brief: "ships the smallest working change" },
  { name: "Hypatia", role: "Analyst", brief: "maps the system before touching it" },
  { name: "Turing", role: "Adversary", brief: "tries to break every claim" },
]

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
    budgetMs: 3_600_000,
    checkEveryMs: 120_000,
    maxTurns: 30,
    maxForemanTurns: 4,
  })
}

describe("field prompts", () => {
  test("kickoff defines the Arena, the roster and the protocol", () => {
    const prompt = kickoffPrompt({
      contract,
      member: { label: "Ada", role: "Builder", brief: "ships the smallest working change" },
      peers: ["Hypatia", "Turing"],
      deadlineMinutes: 90,
      crew,
      now: 1_000,
      mentionTimeoutSeconds: 60,
      leaseMinutes: 10,
    })
    expect(prompt).toContain(contract.objective)
    expect(prompt).toContain("You are Ada")
    expect(prompt).toContain("The Arena is a live room")
    for (const persona of crew) expect(prompt).toContain(persona.name)
    expect(prompt).toContain("referee")
    expect(prompt).toContain("Split mode: your lane is an ownership boundary")
    expect(prompt).toContain("intent")
    expect(prompt).toContain("named mention is an ask")
    expect(prompt).toContain("arena_bus post")
    expect(prompt).toContain("continuous")
    expect(prompt).toContain("claim")
  })

  test("kickoff tells the truth about a shared tree and a private copy", () => {
    const shared = kickoffPrompt({
      contract,
      member: { label: "Ada", role: "Builder", brief: "ships the smallest working change" },
      peers: ["Hypatia"],
      deadlineMinutes: 30,
      crew,
      coordination: "independent",
      sameRole: "Builder",
      copyOnWrite: false,
    })
    expect(shared).toContain("SHARED tree")
    expect(shared).toContain("There is no private copy")
    expect(shared).not.toContain("Your writable copy")
    expect(shared).not.toContain("Your tree is a private copy")

    const copy = kickoffPrompt({
      contract,
      member: { label: "Ada", role: "Builder", brief: "ships the smallest working change" },
      peers: ["Hypatia"],
      deadlineMinutes: 30,
      crew,
      coordination: "independent",
      sameRole: "Builder",
      copyOnWrite: true,
      workspaceRoot: "/base",
      workspacePath: "/copy/Ada",
    })
    expect(copy).toContain("Workspace: copy-on-write")
    expect(copy).toContain("Your writable copy: /copy/Ada")
    expect(copy).toContain("Your tree is a private copy")
  })

  test("kickoff assigns a lane, and race mode expects duplicate attempts", () => {
    const prompt = kickoffPrompt({
      contract,
      member: { label: "Ada", role: "Builder", brief: "ships the smallest working change" },
      peers: ["Hypatia"],
      deadlineMinutes: 30,
      crew,
      coordination: "race",
      workstream: {
        id: "attempt-1",
        name: "Attempt 1",
        kind: "attack",
        owns: ["Acrobat.dll"],
        firstTest: "run the static path",
        doneWhen: "the attempt has a verdict",
      },
    })
    expect(prompt).toContain("Your lane: Attempt 1")
    expect(prompt).toContain("You own: Acrobat.dll")
    expect(prompt).toContain("Race mode")
    expect(prompt).toContain("do not stop because a peer")
  })

  test("Vera's role is separate from the per-check board", () => {
    const role = refereeRole({ contract })
    expect(role).toContain("You are Vera")
    expect(role).toContain(contract.objective)
    const check = refereePrompt({ board: "Goal: x\nStatus: running", budgetLine: "Elapsed: 2m." })
    expect(check).toContain("Goal: x")
    expect(check).not.toContain("You are Vera")
    expect(check).not.toContain(contract.objective)
  })

  test("the fallback crew has unique real names and a role each", () => {
    const made = makeCrew(6)
    expect(made).toHaveLength(6)
    expect(new Set(made.map((seat) => seat.name)).size).toBe(6)
    expect(made.every((seat) => (seat.role ?? "").length > 0 && seat.brief.length > 20)).toBe(true)
  })

  test("inbox keeps the newest messages, in order, and stays within the 256k budget", () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      id: `m${index}`,
      author: "Hypatia",
      kind: "finding" as const,
      text: "x".repeat(1_000),
      to: "all" as const,
      at: index,
    }))
    const prompt = inboxPrompt({ objective: "fix it", items, omitted: 2, now: 10 })
    expect(prompt).toContain("m299")
    expect(prompt).not.toContain("m0")
    expect(prompt).toContain("older message(s) omitted")
    expect(prompt).toContain("Replying is optional for ordinary")
    expect(prompt).not.toContain("Replying is optional\n")
    expect(prompt.length).toBeLessThanOrEqual(260_000)
    expect(prompt).toContain("age=")
  })

  test("a mention is an obligation with a deadline", () => {
    const prompt = inboxPrompt({
      objective: "fix it",
      items: [
        {
          id: "m4",
          author: "Ada",
          kind: "request",
          text: "which file?",
          to: "all",
          at: 1_000,
          mention: true,
          replyBy: 61_000,
          fromMessageID: "m4",
        },
      ],
      omitted: 0,
      now: 2_000,
    })
    expect(prompt).toContain("MENTION")
    expect(prompt).toContain("replyTo")
    expect(prompt).toContain("59s")
    expect(prompt).not.toContain("Replying is optional")
  })

  test("@all is attention, not a reply debt", () => {
    const prompt = inboxPrompt({
      objective: "fix it",
      items: [
        {
          id: "m9",
          author: "Ada",
          kind: "chat",
          text: "@all the fixture is reset",
          to: "all",
          at: 1_000,
          mention: true,
          mentionAll: true,
        },
      ],
      omitted: 0,
      now: 2_000,
    })
    expect(prompt).toContain("ALL")
    expect(prompt).toContain("not a reply debt")
    expect(prompt).not.toContain("A named MENTION is a direct ask")
  })

  test("parseReferee reads continue, pulse and abort, and rejects the old manager actions", () => {
    expect(parseReferee('{"action":"continue"}')).toEqual({ action: "continue", reason: undefined })
    expect(parseReferee('{"action":"pulse","reason":"quiet"}')).toEqual({ action: "pulse", reason: "quiet" })
    expect(parseReferee('{"action":"abort","reason":"stuck"}')).toEqual({ action: "abort", reason: "stuck" })
    expect(parseReferee('{"action":"nudge","target":"Ada"}')).toBeUndefined()
    expect(parseReferee('{"action":"close","claim":"Ada"}')).toBeUndefined()
    expect(parseReferee("no json here")).toBeUndefined()
  })

  test("socialBlock shows asks, waits, leases and lessons", () => {
    let state = field()
    state = noteMention(state, {
      id: "m4",
      from: "Ada",
      to: "Hypatia",
      text: "which file owns the parser?",
      at: 1_000,
      replyBy: 61_000,
      requiresReply: true,
      senderWaits: true,
    })
    state = noteIntent(state, {
      id: "m5",
      owner: "Ada",
      area: "parser",
      note: "taking parser",
      at: 1_000,
      expiresAt: 601_000,
    })
    state = noteLesson(state, { label: "Hypatia", text: "reset the fixture first", at: 1_000 })
    const text = socialBlock({ state, label: "Hypatia", now: 2_000 })
    expect(text).toContain("Open asks for you")
    expect(text).toContain("Ada")
    expect(text).toContain("Active area claims")
    expect(text).toContain("Team lessons")
  })

  test("boardText lists members, awaits, leases, claims and dead ends", () => {
    let state = field()
    state = noteMention(state, {
      id: "m4",
      from: "Ada",
      to: "Hypatia",
      text: "which file?",
      at: 1_000,
      replyBy: 61_000,
      requiresReply: true,
      senderWaits: true,
    })
    state = noteIntent(state, {
      id: "m5",
      owner: "Ada",
      area: "parser",
      note: "taking parser",
      at: 1_000,
      expiresAt: 601_000,
    })
    state = noteLesson(state, { label: "Hypatia", text: "reset the fixture first", at: 1_000 })
    const text = boardText({ state, lastPost: { Ada: "reduced to n=3" }, now: 10_000 })
    expect(text).toContain("Ada")
    expect(text).toContain("dead ends")
    expect(text).toContain("Open asks")
    expect(text).toContain("Area claims")
    expect(text).toContain("Lessons")
    expect(text).toContain("reduced to n=3")
  })
})
