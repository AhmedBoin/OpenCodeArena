import { describe, expect, test } from "bun:test"
import { openField, type FieldState } from "../../src/core/field.ts"
import {
  checkLease,
  grantLease,
  heartbeatLease,
  releaseLease,
} from "../../src/core/lease.ts"
import { STANCES, type ProblemContract } from "../../src/types.ts"

const contract: ProblemContract = {
  objective: "Guard the shared file",
  constraints: ["one writer"],
  successCriteria: ["no overlap"],
  nonGoals: [],
}

function field(): FieldState {
  return openField({
    id: "field-1",
    parentSessionID: "parent",
    contract,
    members: [
      { label: "Ada", agent: "build", stance: STANCES[0]!, sessionID: "s-ada" },
      { label: "Curie", agent: "plan", stance: STANCES[1]!, sessionID: "s-curie" },
    ],
    now: 1_000,
    budgetMs: 60_000,
    checkEveryMs: 10_000,
    maxTurns: 10,
    maxForemanTurns: 4,
  })
}

describe("leases", () => {
  test("a second write lease on the same path is refused with the first owner", () => {
    const first = grantLease(field(), {
      owner: "Ada",
      area: "Acrobat.dll",
      kind: "write",
      paths: ["C:/Acrobat/Acrobat.dll"],
      now: 1_000,
      ttlMs: 300_000,
    })
    expect(first.token).toBeDefined()
    expect(first.conflict).toBeUndefined()
    expect(first.state.intents).toHaveLength(1)

    const second = grantLease(first.state, {
      owner: "Curie",
      area: "Acrobat.dll",
      kind: "write",
      paths: ["c:\\acrobat\\ACROBAT.DLL"],
      now: 2_000,
      ttlMs: 300_000,
    })
    expect(second.token).toBeUndefined()
    expect(second.conflict).toEqual({ owner: "Ada", area: "Acrobat.dll" })
    expect(second.state.intents).toHaveLength(1)
  })

  test("copy-on-write makes write leases private, while launches still serialize", () => {
    const privateTree = { ...field(), copyOnWrite: true }
    const first = grantLease(privateTree, {
      owner: "Ada",
      area: "UltraISO.exe",
      kind: "write",
      paths: ["C:/work/Ada/UltraISO.exe"],
      now: 1_000,
      ttlMs: 300_000,
    })
    const second = grantLease(first.state, {
      owner: "Curie",
      area: "UltraISO.exe",
      kind: "write",
      paths: ["C:/work/Curie/UltraISO.exe"],
      now: 2_000,
      ttlMs: 300_000,
    })
    expect(second.token).toBeDefined()
    expect(second.conflict).toBeUndefined()

    const launch = grantLease(second.state, {
      owner: "Ada",
      area: "UltraISO.exe launch",
      kind: "launch",
      paths: ["UltraISO.exe"],
      now: 3_000,
      ttlMs: 300_000,
    })
    const secondLaunch = grantLease(launch.state, {
      owner: "Curie",
      area: "UltraISO.exe launch",
      kind: "launch",
      paths: ["UltraISO.exe"],
      now: 4_000,
      ttlMs: 300_000,
    })
    expect(secondLaunch.token).toBeUndefined()
    expect(secondLaunch.conflict?.owner).toBe("Ada")
  })

  test("read leases overlap", () => {
    const first = grantLease(field(), {
      owner: "Ada",
      area: "reader",
      kind: "read",
      paths: ["C:/work/a.txt"],
      now: 1_000,
      ttlMs: 10_000,
    })
    const second = grantLease(first.state, {
      owner: "Curie",
      area: "reader",
      kind: "read",
      paths: ["c:\\WORK\\a.txt"],
      now: 1_001,
      ttlMs: 10_000,
    })

    expect(second.token).toBeDefined()
    expect(second.conflict).toBeUndefined()
    expect(second.state.intents).toHaveLength(2)
  })

  test("an expired token fails and a live one passes", () => {
    const granted = grantLease(field(), {
      owner: "Ada",
      area: "x",
      kind: "write",
      paths: ["x"],
      now: 1_000,
      ttlMs: 1_000,
    })
    const token = granted.token!

    expect(checkLease(granted.state, { token, owner: "Ada", now: 1_500 }).ok).toBe(true)
    expect(checkLease(granted.state, { token, owner: "Ada", now: 3_000 }).ok).toBe(false)
    expect(checkLease(granted.state, { token, owner: "Curie", now: 1_500 }).ok).toBe(false)
    expect(checkLease(granted.state, { token, owner: "Ada", now: 1_500, path: "y" }).ok).toBe(false)
  })

  test("heartbeat extends the lease", () => {
    const granted = grantLease(field(), {
      owner: "Ada",
      area: "x",
      kind: "write",
      paths: ["x"],
      now: 1_000,
      ttlMs: 1_000,
    })
    const token = granted.token!
    expect(granted.state.intents?.[0]?.expiresAt).toBe(2_000)

    const beaten = heartbeatLease(granted.state, { token, owner: "Ada", now: 1_500, ttlMs: 5_000 })
    expect(beaten.intents?.[0]?.heartbeatAt).toBe(1_500)
    expect(beaten.intents?.[0]?.expiresAt).toBe(6_500)
    expect(checkLease(beaten, { token, owner: "Ada", now: 6_000 }).ok).toBe(true)
    expect(checkLease(beaten, { token, owner: "Ada", now: 7_000 }).ok).toBe(false)

    expect(granted.state.intents?.[0]?.expiresAt).toBe(2_000)
  })

  test("release frees the path for the next writer", () => {
    const first = grantLease(field(), {
      owner: "Ada",
      area: "shared",
      kind: "write",
      paths: ["C:/shared/file.txt"],
      now: 1_000,
      ttlMs: 300_000,
    })
    const released = releaseLease(first.state, {
      owner: "Ada",
      token: first.token,
      now: 2_000,
    })
    expect(released.intents?.[0]?.status).toBe("released")

    const second = grantLease(released, {
      owner: "Curie",
      area: "shared",
      kind: "write",
      paths: ["C:/shared/file.txt"],
      now: 2_001,
      ttlMs: 300_000,
    })
    expect(second.token).toBeDefined()
    expect(second.conflict).toBeUndefined()
    expect(second.state.intents).toHaveLength(2)
  })
})
