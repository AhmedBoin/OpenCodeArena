import type { ModelRef } from "./types.ts"

/** Accepts provider/model or provider/model#variant, the same form as agent config. */
export function parseModel(text: string): ModelRef | undefined {
  const [reference, variant] = text.split("#", 2)
  if (!reference) return undefined
  const slash = reference.indexOf("/")
  if (slash <= 0 || slash === reference.length - 1) return undefined
  return {
    providerID: reference.slice(0, slash),
    id: reference.slice(slash + 1),
    variant: variant && variant.length > 0 ? variant : undefined,
  }
}

export function modelRefs(values: unknown): ModelRef[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (typeof value !== "string") return []
    const parsed = parseModel(value)
    return parsed ? [parsed] : []
  })
}

/** Referee/coordinator work is scheduling, not deep analysis; prefer the low variant. */
export function fastModel(model: ModelRef | undefined): ModelRef | undefined {
  if (!model?.variant) return model
  if (!["high", "max", "medium"].includes(model.variant)) return model
  return { ...model, variant: "low" }
}

export function formatModel(model: ModelRef | undefined): string {
  if (!model) return "default"
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}
