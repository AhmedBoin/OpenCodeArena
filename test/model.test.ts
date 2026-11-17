import { describe, expect, test } from "bun:test"
import { fastModel } from "../src/model.ts"

describe("model routing", () => {
  test("the referee gets the low variant when the parent is high or max", () => {
    expect(fastModel({ providerID: "p", id: "m", variant: "high" })?.variant).toBe("low")
    expect(fastModel({ providerID: "p", id: "m", variant: "max" })?.variant).toBe("low")
    expect(fastModel({ providerID: "p", id: "m" })?.variant).toBeUndefined()
    expect(fastModel({ providerID: "p", id: "m", variant: "low" })?.variant).toBe("low")
  })
})
