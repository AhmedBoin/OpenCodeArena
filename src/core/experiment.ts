/**
 * Bounded experiments.
 *
 * One experiment runs at a time. A result is only admissible when it names the
 * experiment and carries an observation, and a launch that reused the previous
 * process is `invalid` even if the readback looks right. That single check is
 * what E5/E6 in the Acrobat field lacked.
 */

import type { Experiment } from "../types.ts"
import type { FieldState } from "./field.ts"

export interface StartExperimentInput {
  owner: string
  lane?: string
  hypothesis: string
  command: string
  expect: string
  killIf: string
  preflight?: string
  baseline?: string
  evidence?: string[]
  now: number
  maxExperiments: number
}

export interface FinishExperimentInput {
  owner: string
  id: string
  status: "pass" | "fail" | "invalid"
  observed?: string
  result?: string
  evidence?: string[]
  pidBefore?: string
  pidAfter?: string
  now: number
}

export interface ExperimentOutcome {
  state: FieldState
  experiment?: Experiment
  error?: string
}

function clone(state: FieldState): FieldState {
  return structuredClone(state)
}

export function runningExperiments(state: FieldState): Experiment[] {
  return (state.experiments ?? []).filter((experiment) => experiment.status === "running")
}

export function runningExperiment(state: FieldState): Experiment | undefined {
  return runningExperiments(state)[0]
}

export function experimentCount(state: FieldState): number {
  // An invalid run still spent wall-clock and attention. Counting it keeps a
  // sequence of "invalid" relaunches from bypassing the experiment budget.
  return (state.experiments ?? []).filter((experiment) => experiment.status !== "cancelled").length
}

export function startExperiment(state: FieldState, input: StartExperimentInput): ExperimentOutcome {
  if (!state.oracle) return { state, error: "no oracle on the board; name the pass/fail observable first" }
  if (state.oracle.confirmed !== true) {
    return { state, error: "oracle is unconfirmed; capture the baseline and post kind=oracle first" }
  }
  // A historical log is not a baseline for this field. If the author supplied a
  // time, it has to be at or after the field started.
  const baselineAt = state.oracle.baselineAt ?? state.oracle.capturedAt
  if (baselineAt !== undefined && baselineAt < state.startedAt) {
    return { state, error: "oracle baseline predates this field; capture a fresh baseline before starting a test" }
  }
  // One active test per seat and per resource, not one for the whole field.
  // Independent seats should be able to test different resources in parallel;
  // two tests that name the same lane still serialize.
  const lane = input.lane?.replace(/\s+/g, " ").trim().toLowerCase()
  const active = runningExperiments(state).find(
    (experiment) =>
      experiment.owner === input.owner || (lane !== undefined && lane.length > 0 && experiment.lane?.trim().toLowerCase() === lane),
  )
  if (active) {
    return {
      state,
      error:
        active.owner === input.owner
          ? `${active.owner} is already running ${active.id}; post its result before starting another test`
          : `${active.owner} is running ${active.id} on ${active.lane ?? "the same area"}; wait for its result`,
    }
  }
  if (input.maxExperiments > 0 && experimentCount(state) >= input.maxExperiments) {
    return { state, error: `experiment budget spent (${input.maxExperiments}); decide or report` }
  }
  const hypothesis = input.hypothesis.replace(/\s+/g, " ").trim()
  const command = input.command.replace(/\s+/g, " ").trim()
  const expect = input.expect.replace(/\s+/g, " ").trim()
  if (hypothesis.length < 8) return { state, error: "test needs a hypothesis sentence" }
  if (command.length === 0) return { state, error: "test needs one command" }
  if (expect.length < 4) return { state, error: "test needs an expected observation (expect)" }

  const id = `e${(state.experiments ?? []).length + 1}`
  const experiment: Experiment = {
    id,
    owner: input.owner,
    lane: input.lane,
    hypothesis,
    command,
    expect,
    killIf: input.killIf.replace(/\s+/g, " ").trim(),
    preflight: input.preflight?.replace(/\s+/g, " ").trim(),
    status: "running",
    baseline: input.baseline,
    evidence: [...(input.evidence ?? [])],
    startedAt: input.now,
  }
  const next = clone(state)
  next.experiments = [...(next.experiments ?? []), experiment]
  return { state: next, experiment }
}

export function finishExperiment(state: FieldState, input: FinishExperimentInput): ExperimentOutcome {
  const experiment = (state.experiments ?? []).find((entry) => entry.id === input.id)
  if (!experiment) return { state, error: `no experiment ${input.id}` }
  if (experiment.status !== "running") return { state, error: `${input.id} is already ${experiment.status}` }
  if (experiment.owner !== input.owner) return { state, error: `${input.id} belongs to ${experiment.owner}` }

  const observed = input.observed?.replace(/\s+/g, " ").trim()
  const evidence = [...(input.evidence ?? [])]
  if (!observed && evidence.length === 0) return { state, error: "result needs raw output in observed or evidence" }

  let status = input.status
  let result = input.result?.trim() ?? ""
  const before = input.pidBefore?.trim()
  const after = input.pidAfter?.trim()
  if (before && after && before === after) {
    status = "invalid"
    result = `same process reused (${before}); no cold start, result is invalid`
  }
  if (status !== "invalid" && experiment.command.length > 0 && !observed && evidence.length === 0) {
    return { state, error: "result needs the command output" }
  }

  const next = clone(state)
  const current = (next.experiments ?? []).find((entry) => entry.id === input.id)!
  current.status = status
  current.observed = observed
  current.result = result
  current.evidence = [...current.evidence, ...evidence]
  current.endedAt = input.now
  return { state: next, experiment: current }
}

/** A result line for the room, short enough to survive the post limit. */
export function experimentLine(experiment: Experiment): string {
  return `${experiment.id} ${experiment.status}: ${experiment.result || experiment.expect}`
}
