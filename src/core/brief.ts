/**
 * Brief analysis — the deterministic plan a field starts from.
 *
 * `analyzeBrief` reads a ProblemContract and answers four questions before any
 * model session exists: what shape the work is, whether lanes should split or
 * race, who owns what, and which hypotheses deserve a time box. It is pure:
 * same contract in, same analysis out. No model, no I/O, no external state.
 */

import type {
  BriefAnalysis,
  BriefHypothesis,
  CoordinationMode,
  Oracle,
  ProblemContract,
  Workstream,
  WorkstreamKind,
} from "../types.ts"

type Shape = BriefAnalysis["shape"]
type Confidence = BriefAnalysis["confidence"]

const COMPLEX_TERMS =
  /\b(?:webhook|order|concurren\w*|duplicate|auth|database|schema|migrat\w*|security|api|distributed|performance|optimi\w*|refactor)\b/

const APP_PATTERN =
  /\b(?:adobe acrobat|acrobat|photoshop|microsoft office|windows|chrome|firefox|visual studio code|vscode|docker|steam|spotify)\b(?:\s+\d+(?:\.\d+)*)?/i

const APP_CONTEXT = /\b(?:acrobat|adobe|app|desktop|install|installed|machine|edition|windows|macos)\b/

const MULTI_SYSTEM = /\b(?:external systems?|multiple systems?|multiple repos?|multiple services?|two services?|three services?)\b/

const RACE_STRONG =
  /\b(?:crack(?:ing|ed)?|bypass(?:ing|ed)?|exploit(?:ing|ed)?|brute[-\s]?force|patch(?:ing|ed)?|attack(?:ing|ed)?|racing|race|compete|competing|competition|parallel(?:ly)?|simultaneous(?:ly)?|scrap(?:e|ing)|download(?:ing)?|permanent(?:ly)?|licen[cs]e|activate|activation|unlock|keygen|jailbreak|different approaches?|alternative approaches?|multiple approaches?|same (?:target|login|resource|endpoint|file|account)|try (?:multiple|several|two|three|four|\d+))\b/

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function lower(text: string): string {
  return squash(text).toLowerCase()
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function briefText(contract: ProblemContract): string {
  return lower(
    [
      contract.objective,
      contract.context ?? "",
      ...contract.constraints,
      ...contract.successCriteria,
      ...contract.nonGoals,
    ].join(" . "),
  )
}

function extractPaths(text: string): string[] {
  const pattern = /[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|md|json|ya?ml|css|html|py|go|rs|java|cpp|sh|ps1|toml)/gi
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const path = match[0]
    if (!found.some((entry) => entry.toLowerCase() === path.toLowerCase())) found.push(path)
  }
  return found
}

function extractScope(objective: string): string[] {
  const paths = extractPaths(objective)
  if (paths.length > 0) return paths
  const readme = /\breadme(?:\.md)?\b/i.exec(objective)
  if (readme?.[0]) return [readme[0]]
  const docs = /\b(?:docs?|documentation|changelog)\b/i.exec(objective)
  if (docs?.[0]) return [docs[0]]
  return []
}

function extractTarget(objective: string): string {
  const same = /\bsame\s+([A-Za-z0-9][\w .:/-]{0,40})/i.exec(objective)
  if (same?.[1]) {
    const trimmed = squash(same[1])
      .replace(/\s+(?:and|to|for|with|on|that|which)\s+.*$/i, "")
      .replace(/[.,;:!?]+$/, "")
      .trim()
    if (trimmed.length >= 2) return trimmed
  }
  const app = APP_PATTERN.exec(objective)
  if (app?.[0]) return squash(app[0])
  const scope = extractScope(objective)
  const first = scope[0]
  if (first) return first
  return "the target"
}

function fileCountFrom(objective: string): number | undefined {
  const patterns = [
    /\b(\d{1,5})\s*(?:-\s*)?(?:[a-z]+\s+){0,2}(?:files?|documents?|items?|records?|entries?|pages?)\b/i,
    /\b(\d{1,5})-(?:file|document|item|record|page)\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(objective)
    const raw = match?.[1]
    if (!raw) continue
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return undefined
}

const DELIVERABLE_VERB = /^(?:add|build|create|implement|introduce|support|ship)\b/i

/**
 * Split an objective into independently named deliverables. Only clauses that
 * start with an implement verb count, so a sentence like "make X permanently
 * Pro" is not mistaken for a deliverable list.
 */
function extractDeliverables(objective: string): string[] {
  const clauses = objective
    .replace(/\band\b/gi, ",")
    .split(/[,;]+/)
    .map((clause) => squash(clause).replace(/^[-*:.\s]+/, ""))
    .filter((clause) => clause.length > 0)
  const found: string[] = []
  for (const clause of clauses) {
    if (!DELIVERABLE_VERB.test(clause)) continue
    const name = squash(
      clause
        .replace(DELIVERABLE_VERB, "")
        .replace(/^(?:a|an|the|new)\b/i, "")
        .replace(/[.]+$/, ""),
    )
    if (name.length >= 2 && name.length <= 80) found.push(name)
  }
  return unique(found).slice(0, 6)
}

function explicitAttempts(brief: string): number | undefined {
  const match =
    /\b(?:try|test|attempt|run|use)?\s*(two|three|four|five|\d)\s+(?:different|independent|separate|alternative)?\s*(?:approaches|attempts|routes|ways|lanes|variants|angles|methods)\b/i.exec(
      brief,
    )
  const raw = match?.[1]?.toLowerCase()
  if (!raw) return undefined
  const value = COUNT_WORDS[raw] ?? Number(raw)
  return Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

function shapeScore(shape: Shape, brief: string, fileCount: number | undefined): number {
  switch (shape) {
    case "migrate": {
      if (/\bmigrat(?:e|es|ed|ing|ion)\b/.test(brief)) return 6
      if (/\b(?:upgrade|convert|port|rewrite)\b[^.]{0,40}\b(?:to|into)\b/.test(brief)) return 4
      if (/\b(?:frontmatter|new format|file format)\b/.test(brief)) return 2
      return 0
    }
    case "batch": {
      if (fileCount !== undefined && fileCount >= 10) return 5
      if (fileCount !== undefined && fileCount >= 3) return 2
      if (/\b(?:batch|bulk|dozens|hundreds|thousands|all (?:the )?(?:files|documents|items|records)|every (?:file|document|item|record))\b/.test(brief)) {
        return 4
      }
      return 0
    }
    case "audit": {
      if (/\baudit\b(?!\s+(?:log|trail|logging))/.test(brief)) return 5
      if (/\b(?:review|assess|inspect|harden|penetration|threat model|vulnerabilit|security)\b/.test(brief)) return 2
      return 0
    }
    case "research": {
      if (/\b(?:bypass|crack|exploit|brute[-\s]?force|activate|activation|licen[cs]e|permanent(?:ly)?|unlock|keygen|jailbreak|reverse engineer|patch)\b/.test(brief)) {
        return 5
      }
      if (/\b(?:research|investigate|figure out|determine|discover|prove|compare|either)\b/.test(brief)) return 3
      if (/\b(?:login|sign in|access|scrape|download|why|how to)\b/.test(brief)) return 1
      return 0
    }
    case "fix": {
      if (/\b(?:fix|repair|typo|bug|crash|broken|regression|duplicate|correct|resolve|wrong)\b/.test(brief)) return 5
      if (/\b(?:error|fails?|failing|issue)\b/.test(brief)) return 2
      return 0
    }
    case "build": {
      if (/\b(?:add|build|create|implement|introduce|support|ship)\b/.test(brief)) return 4
      if (/\b(?:new|feature|endpoint|api|page|component|service|module)\b/.test(brief)) return 1
      return 0
    }
  }
}

function detectShape(brief: string, objective: string, fileCount: number | undefined): Shape {
  const order: Shape[] = ["research", "audit", "migrate", "fix", "build", "batch"]
  let best: Shape = objective.length > 80 ? "build" : "fix"
  let bestScore = 0
  for (const shape of order) {
    const score = shapeScore(shape, brief, fileCount)
    if (score > bestScore) {
      best = shape
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

function detectRace(brief: string): boolean {
  if (RACE_STRONG.test(brief)) return true
  const weak = brief.match(/\b(?:attempts?|approaches?|routes?|variants?|lanes?|independently|concurrently|alternatives?)\b/g)
  return (weak?.length ?? 0) >= 2
}

function detectSplitReasons(brief: string, fileCount: number | undefined, deliverables: string[]): string[] {
  const reasons: string[] = []
  if (deliverables.length >= 2) reasons.push(`${deliverables.length} named deliverables`)
  if (fileCount !== undefined && fileCount >= 3) reasons.push(`${fileCount} target files`)
  const counted =
    /\b(?:two|three|four|five|\d{1,3})\s+(?:independent\s+|separate\s+)?(?:deliverables?|components?|files?|stages?|lanes?|modules?|parts?|tasks?|pipelines?|services?)\b/.exec(
      brief,
    )
  if (counted) reasons.push(`explicit multi-part count (${counted[0]})`)
  if (/\b(?:deliverables?|components?|modules?|stages?|workstreams?|subsystems?)\b/.test(brief)) reasons.push("component wording")
  return unique(reasons)
}

function isSimpleFix(args: {
  shape: Shape
  brief: string
  objective: string
  scope: string[]
  deliverables: string[]
  race: boolean
  split: boolean
  fileCount: number | undefined
}): boolean {
  if (args.shape !== "fix") return false
  if (args.race || args.split || args.deliverables.length > 0) return false
  if (args.fileCount !== undefined) return false
  if (args.objective.length > 60) return false
  if (COMPLEX_TERMS.test(args.brief)) return false
  return args.scope.length > 0 || args.objective.length <= 32
}

// ---------------------------------------------------------------------------
// Workstreams
// ---------------------------------------------------------------------------

interface LanePlan {
  workstreams: Workstream[]
  roles: string[]
}

interface AttemptTemplate {
  name: string
  firstTest: (target: string) => string
}

const APP_ATTEMPTS: AttemptTemplate[] = [
  {
    name: "static patch",
    firstTest: (target) => `inspect the installed files for ${target} and diff the artifact that gates the reported state`,
  },
  {
    name: "runtime patch",
    firstTest: (target) => `change one runtime variable for ${target}, relaunch it, and re-read the reported state`,
  },
  {
    name: "remote/UI activation",
    firstTest: (target) => `reproduce ${target} from a clean start and capture exactly what the UI or server refuses`,
  },
  {
    name: "cache/state replay",
    firstTest: (target) => `replay the cached activation state for ${target} after a restart and compare`,
  },
]

const AUTH_ATTEMPTS: AttemptTemplate[] = [
  {
    name: "credential attempt",
    firstTest: (target) => `run the cheapest credential route against ${target} and capture status, headers, and body`,
  },
  {
    name: "request/parameter attempt",
    firstTest: (target) => `send one mutated request to ${target} and diff the response against the baseline`,
  },
  {
    name: "session/state attempt",
    firstTest: (target) => `replay ${target} with a pre-seeded session and compare the response`,
  },
  {
    name: "concurrency attempt",
    firstTest: (target) => `issue two concurrent requests to ${target} and compare the outcomes`,
  },
]

const GENERIC_ATTEMPTS: AttemptTemplate[] = [
  {
    name: "direct attempt",
    firstTest: (target) => `run the cheapest direct route against ${target} and capture the raw output`,
  },
  {
    name: "offline/static attempt",
    firstTest: (target) => `inspect the local files behind ${target} and diff the state that gates the outcome`,
  },
  {
    name: "runtime attempt",
    firstTest: (target) => `change one variable at runtime for ${target} and re-read the observed state`,
  },
  {
    name: "clean-start attempt",
    firstTest: (target) => `reproduce ${target} from a clean start with no cache and compare the result`,
  },
]

const ATTEMPT_ROLES: Record<string, string> = {
  "static patch": "static analyst",
  "runtime patch": "runtime patcher",
  "remote/UI activation": "remote operator",
  "cache/state replay": "state replayer",
  "credential attempt": "credential attacker",
  "request/parameter attempt": "request attacker",
  "session/state attempt": "session attacker",
  "concurrency attempt": "concurrency attacker",
  "direct attempt": "attacker",
  "offline/static attempt": "static analyst",
  "runtime attempt": "runtime patcher",
  "clean-start attempt": "clean-start operator",
}

function attemptTemplates(brief: string): AttemptTemplate[] {
  if (/\b(?:login|auth|password|session|token|sign[-\s]?in|access)\b/.test(brief)) return AUTH_ATTEMPTS
  if (/\b(?:acrobat|adobe|app|desktop|install|installed|machine|edition|windows|macos)\b/.test(brief)) return APP_ATTEMPTS
  return GENERIC_ATTEMPTS
}

function lane(
  id: string,
  name: string,
  kind: WorkstreamKind,
  owns: string[],
  firstTest: string,
  doneWhen: string,
): Workstream {
  return { id, name, kind, owns: unique(owns), firstTest, doneWhen }
}

function simplePlan(target: string, scope: string[], verificationCommand?: string): LanePlan {
  const owner = scope.length > 0 ? scope : ["the reported file"]
  return {
    workstreams: [
      lane(
        "w-implement",
        "implement",
        "implement",
        owner,
        `read ${target} and locate the exact defect before changing it`,
        `${target} carries the intended fix and no unrelated line changed`,
      ),
      lane(
        "w-verify",
        "verify",
        "verify",
        ["verification"],
        verificationCommand ? `run ${verificationCommand} and capture the exit code` : `re-read ${target} and run the nearest project check that covers it`,
        "the corrected state is observed in raw output, not asserted",
      ),
    ],
    roles: ["implementer", "verifier"],
  }
}

function fixPlan(scope: string[], verificationCommand?: string): LanePlan {
  const owner = scope.length > 0 ? scope : ["the reported area"]
  return {
    workstreams: [
      lane(
        "w-implement",
        "implement",
        "implement",
        owner,
        "reproduce the defect once with a command, then edit the smallest owning surface",
        "the defect no longer reproduces and only owned paths changed",
      ),
      lane(
        "w-verify",
        "verify",
        "verify",
        ["verification"],
        verificationCommand ? `run ${verificationCommand}` : "run every check that covers the edited surface",
        "the result is captured as command output",
      ),
      lane(
        "w-adversary",
        "adversary",
        "attack",
        ["failure modes"],
        "attack the fix with the original repro plus one hostile input",
        "no attack reproduces the defect and the worst case is written down",
      ),
    ],
    roles: ["implementer", "verifier", "adversary"],
  }
}

function splitPlan(deliverables: string[], verificationCommand?: string): LanePlan {
  const workstreams = deliverables.map((deliverable, index) =>
    lane(
      `w-deliver-${index + 1}`,
      `implement ${deliverable}`,
      "implement",
      [deliverable],
      `write the smallest failing check for "${deliverable}" and run it`,
      `"${deliverable}" is present and its check passes without touching another lane`,
    ),
  )
  workstreams.push(
    lane(
      "w-verify",
      "verify",
      "verify",
      ["verification"],
      verificationCommand ? `run ${verificationCommand} after all lanes land` : `run the end-to-end check that exercises ${deliverables.join(", ")}`,
      "every deliverable is exercised in one run",
    ),
  )
  return {
    workstreams,
    roles: [...deliverables.map((deliverable) => `${deliverable} implementer`), "verifier"],
  }
}

function researchPlan(target: string, verificationCommand?: string): LanePlan {
  return {
    workstreams: [
      lane(
        "w-recon",
        "recon",
        "recon",
        ["search space"],
        `map ${target} and name the cheapest discriminating test`,
        "the decision point and the next test are written down",
      ),
      lane(
        "w-falsify",
        "falsifier",
        "attack",
        ["leading hypothesis"],
        `attack the leading hypothesis for ${target} with the cheapest test`,
        "the hypothesis is supported or killed with raw output",
      ),
      lane(
        "w-verify",
        "verify",
        "verify",
        ["user-visible outcome"],
        verificationCommand ? `run ${verificationCommand}` : `reproduce the user-visible outcome for ${target} from a clean start`,
        "the observed outcome is recorded, not asserted",
      ),
      lane(
        "w-integrate",
        "integrate",
        "integrate",
        ["final artifacts"],
        "collect raw outputs, the surviving route, and every untested route into one report",
        "artifacts and remaining routes are listed",
      ),
    ],
    roles: ["recon", "falsifier", "verifier", "integrator"],
  }
}

function auditPlan(verificationCommand?: string): LanePlan {
  return {
    workstreams: [
      lane(
        "w-recon",
        "recon",
        "recon",
        ["search space"],
        "map the attack surface and name the highest-severity candidate",
        "the candidate and the entry point that reaches it are written down",
      ),
      lane(
        "w-audit",
        "auditor",
        "attack",
        ["suspect areas"],
        "reproduce the highest-severity candidate from a real entry point",
        "each claim carries a reproducing command and raw output",
      ),
      lane(
        "w-verify",
        "verify",
        "verify",
        ["verification"],
        verificationCommand ? `run ${verificationCommand}` : "rerun every claimed finding as a clean command",
        "findings reproduce outside the auditor's session",
      ),
      lane(
        "w-integrate",
        "integrate",
        "integrate",
        ["final artifacts"],
        "rank the findings, fix or accept the worst, and list the untested areas",
        "the worst finding is fixed or explicitly accepted",
      ),
    ],
    roles: ["recon", "auditor", "verifier", "integrator"],
  }
}

function migratePlan(fileCount: number | undefined, deliverables: string[]): LanePlan {
  const scope =
    fileCount !== undefined
      ? `${fileCount} target files`
      : deliverables.length > 1
        ? deliverables.join(", ")
        : "every target file"
  return {
    workstreams: [
      lane(
        "w-inventory",
        "inventory",
        "recon",
        ["file inventory"],
        `list every file outside the new format (${scope}) and count them`,
        "the count matches the brief",
      ),
      lane(
        "w-transform",
        "transform",
        "implement",
        ["the target files"],
        "transform one representative file and diff the result",
        "one file migrates with no hand edit",
      ),
      lane(
        "w-sample",
        "sample verify",
        "verify",
        ["verification sample"],
        "spot-check a sample of the transformed files with the project validator",
        "the sample passes and no file is corrupted",
      ),
      lane(
        "w-integrate",
        "integrate",
        "integrate",
        ["final tree"],
        "rerun the transform over the whole tree and re-count",
        "zero unmigrated files remain",
      ),
    ],
    roles: ["inventory", "migrator", "sampler", "integrator"],
  }
}

function buildPlan(deliverables: string[], verificationCommand?: string): LanePlan {
  const owner = deliverables.length > 0 ? deliverables : ["the named change"]
  return {
    workstreams: [
      lane(
        "w-implement",
        "implement",
        "implement",
        owner,
        "write the smallest failing check for the named change and run it",
        "the change is present and its check passes",
      ),
      lane(
        "w-verify",
        "verify",
        "verify",
        ["verification"],
        verificationCommand ? `run ${verificationCommand}` : "run the end-to-end check that exercises the change",
        "the check is captured as raw output",
      ),
    ],
    roles: ["implementer", "verifier"],
  }
}

function racePlan(
  brief: string,
  shape: Shape,
  target: string,
  attemptCount: number,
  verificationCommand?: string,
): LanePlan {
  const pool = attemptTemplates(brief)
  const attempts = pool.slice(0, Math.min(pool.length, attemptCount))
  const workstreams: Workstream[] = []
  const roles: string[] = []
  if (shape === "research" || shape === "audit") {
    workstreams.push(
      lane(
        "w-recon",
        "recon",
        "recon",
        ["search space"],
        `map ${target} and name the cheapest discriminating test`,
        "the decision point and the next test are written down",
      ),
    )
    roles.push("recon")
  }
  attempts.forEach((template, index) => {
    workstreams.push(
      lane(
        `w-attempt-${index + 1}`,
        `attempt ${index + 1}: ${template.name}`,
        "attack",
        [target],
        template.firstTest(target),
        `${target} reaches the wanted state through this route, or the route is refuted with raw output`,
      ),
    )
    roles.push(ATTEMPT_ROLES[template.name] ?? "attacker")
  })
  workstreams.push(
    lane(
      "w-verify",
      "verify",
      "verify",
      ["verification"],
      verificationCommand ? `run ${verificationCommand} after the winning route lands` : `reproduce the wanted state for ${target} from a cold start and capture raw output`,
      `${target} keeps the state through a restart`,
    ),
  )
  roles.push("verifier")
  workstreams.push(
    lane(
      "w-integrate",
      "integrate",
      "integrate",
      ["final artifacts"],
      "collect attempt outputs, name the surviving route, and list the untested ones",
      "one route is supported with output and the rest are listed as refuted",
    ),
  )
  roles.push("integrator")
  return { workstreams, roles: unique(roles) }
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

function simpleFixHypotheses(target: string, verificationCommand?: string): BriefHypothesis[] {
  return [
    {
      id: "h1",
      statement: `the defect named in the brief is localized to ${target} and one focused edit closes it without touching callers`,
      test: verificationCommand ? `run \`${verificationCommand}\` and post the exit code` : `run \`git diff --name-only\` after the first edit and confirm only ${target} changed`,
      killIf: "the defect reproduces after the edit, or a second file must change",
      timeBoxMinutes: 5,
    },
  ]
}

function fixHypotheses(scope: string[], verificationCommand?: string): BriefHypothesis[] {
  const owner = scope.length > 0 ? scope.join(", ") : "the reported area"
  return [
    {
      id: "h1",
      statement: `the defect is confined to ${owner} and one focused edit closes it`,
      test: verificationCommand ? `run \`${verificationCommand}\` and post the exit code` : "run `git diff --name-only` after the first edit and confirm the diff stays narrow",
      killIf: "the defect reproduces after the edit, or a second file must change",
      timeBoxMinutes: 6,
    },
    {
      id: "h2",
      statement: "the reported symptom has one trigger, and no existing caller depends on the current behavior",
      test: "reproduce the original symptom with a command before the fix, then rerun the same command after it",
      killIf: "the symptom has two independent triggers or the repro is not deterministic",
      timeBoxMinutes: 8,
    },
  ]
}

function researchHypotheses(target: string, race: boolean, verificationCommand?: string): BriefHypothesis[] {
  return [
    {
      id: "h1",
      statement: `${target} can reach the wanted state through a local route with no network call`,
      test: verificationCommand
        ? `run \`${verificationCommand}\` once before and once after the cheapest route`
        : `disconnect the network, apply the cheapest local route for ${target}, relaunch, and record the reported state`,
      killIf: "the state reverts on relaunch or the app insists on a server check",
      timeBoxMinutes: 8,
    },
    {
      id: "h2",
      statement: `one local artifact (file, flag, signature, or license blob) gates the outcome for ${target}`,
      test: `diff the installed files for ${target} before and after a single change, then re-read the reported state`,
      killIf: "no single change moves the observed state",
      timeBoxMinutes: 10,
    },
    {
      id: "h3",
      statement: race
        ? `at least one independent route reaches ${target} without the normal gate`
        : `${target} is gated by a remote check, so local edits alone cannot hold the state`,
      test: race
        ? `run the cheapest attempt route against ${target} end to end and capture status and body`
        : `block outbound traffic, relaunch ${target}, and capture the error and the state`,
      killIf: race
        ? "every named route is refused with the same gate and no state changes"
        : "the state persists with no network reachable",
      timeBoxMinutes: 10,
    },
  ]
}

function auditHypotheses(verificationCommand?: string): BriefHypothesis[] {
  return [
    {
      id: "h1",
      statement: "the highest-severity issue is reachable from a real entry point, not only from a test fixture",
      test: verificationCommand
        ? `run \`${verificationCommand}\` against the suspect path and capture the raw output`
        : "reproduce the issue from the documented entry point and capture raw output",
      killIf: "the entry point rejects the input before the suspect code runs",
      timeBoxMinutes: 8,
    },
    {
      id: "h2",
      statement: "the suspect area has no test that would catch the regression",
      test: "revert the suspect change and rerun the nearest suite",
      killIf: "an existing test already fails on that path",
      timeBoxMinutes: 10,
    },
  ]
}

function migrateHypotheses(count: number | undefined, verificationCommand?: string): BriefHypothesis[] {
  const scope = count !== undefined ? `all ${count} files` : "the target files"
  return [
    {
      id: "h1",
      statement: `${scope} share the same pre-migration shape, so one transform covers the batch`,
      test: `count the files that still match the old shape and compare that number to ${count ?? "the brief"}`,
      killIf: "more than a handful of files need hand edits",
      timeBoxMinutes: 8,
    },
    {
      id: "h2",
      statement: "the new format is accepted by the project's own validator with no extra config",
      test: verificationCommand ? `run \`${verificationCommand}\`` : "run the project validator over a sample of migrated files",
      killIf: "the validator rejects migrated output or needs unrelated config changes",
      timeBoxMinutes: 10,
    },
  ]
}

function buildHypotheses(deliverables: string[]): BriefHypothesis[] {
  const first = deliverables.length > 0 ? deliverables.join(", ") : "the named change"
  return [
    {
      id: "h1",
      statement: `each deliverable (${first}) can land in its own area without touching the others`,
      test: "run `git diff --name-only` after the first lane lands and confirm the touched areas stay disjoint",
      killIf: "two deliverables must edit the same lines",
      timeBoxMinutes: 8,
    },
    {
      id: "h2",
      statement: "the deliverables compose behind one existing entry point without a shared-state rewrite",
      test: "run the smallest end-to-end check that exercises every named deliverable",
      killIf: "the integration check fails for reasons no single lane can fix",
      timeBoxMinutes: 10,
    },
  ]
}

// ---------------------------------------------------------------------------
// Resolution contract
// ---------------------------------------------------------------------------

function buildDoneWhen(args: {
  shape: Shape
  brief: string
  target: string
  scope: string[]
  fileCount: number | undefined
  verificationCommand?: string
}): string[] {
  const out: string[] = []
  if (args.verificationCommand) out.push(`\`${args.verificationCommand}\` exits 0 and its raw output is posted`)
  switch (args.shape) {
    case "fix":
      out.push("the reported defect no longer reproduces when the edited surface is exercised")
      out.push(`the final diff touches only ${args.scope.length > 0 ? args.scope.join(", ") : "the owned surface"}`)
      break
    case "build":
      out.push("each named deliverable is present and reachable from one documented entry point")
      out.push("one end-to-end check exercises every deliverable in a single run")
      break
    case "research":
    case "audit":
      out.push("the leading hypothesis is supported or refuted with a command and output")
      out.push(
        args.shape === "audit"
          ? "every claimed finding carries a reproducing command and raw output"
          : `the observed state of ${args.target} is recorded after a clean start`,
      )
      break
    case "migrate":
    case "batch":
      out.push(
        args.fileCount !== undefined
          ? `all ${args.fileCount} target files report the new format`
          : "every target file reports the new format",
      )
      out.push("the project validator or typecheck passes on the migrated tree")
      break
  }
  if ((args.shape === "research" || args.shape === "audit") && APP_CONTEXT.test(args.brief)) {
    out.push(`the wanted state for ${args.target} survives a restart`)
  }
  return unique(out).slice(0, 4)
}

function buildNegativeWhen(shape: Shape, target: string): string[] {
  const out = ["all named local routes tested and refuted", "remaining untested routes listed"]
  switch (shape) {
    case "fix":
      out.push("the reported defect still reproduces after a focused edit")
      break
    case "build":
      out.push("the end-to-end check fails on a shared dependency no lane owns")
      break
    case "research":
      out.push(`every attempt on ${target} reverts on restart or is refused by a remote check`)
      break
    case "audit":
      out.push("the highest-severity finding cannot be reproduced from a real entry point")
      break
    case "migrate":
    case "batch":
      out.push("more than 5% of the target files need hand edits")
      break
  }
  return unique(out).slice(0, 3)
}

/**
 * The observation that decides the task. Recon may replace it, but the field
 * starts with a concrete baseline command instead of an empty contract.
 */
function buildOracle(args: {
  shape: Shape
  brief: string
  target: string
  verificationCommand?: string
}): Oracle {
  if (args.verificationCommand) {
    return {
      observable: `\`${args.verificationCommand}\` exits 0 and its raw output is posted`,
      baseline: `run \`${args.verificationCommand}\` once before any change and save the output`,
      kind: "command",
      confirmed: false,
      source: "verificationCommand",
    }
  }
  if (/(?:app|application|install|license|activation|login|sign.?in|premium|pro\b|trial|ui|window|desktop|reader|viewer)/i.test(args.brief)) {
    return {
      observable: `the application's own visible state after a clean start shows ${args.target} in the wanted state, with no sign-in or trial prompt`,
      baseline: "capture the current application state (window title, visible control, or its own log line) and save it under artifacts",
      kind: "ui",
      confirmed: false,
      source: "ui heuristic",
    }
  }
  if (/(?:api|endpoint|http|https|server|request|response|webhook)/i.test(args.brief)) {
    return {
      observable: "the endpoint returns the wanted status and body for the exact request in the brief",
      baseline: "send the baseline request and save the status, headers, and body",
      kind: "http",
      confirmed: false,
      source: "http heuristic",
    }
  }
  if (/(?:process|service|daemon|launch|runtime|memory|binary|patch)/i.test(args.brief)) {
    return {
      observable: `the process or binary for ${args.target} shows the wanted state after a fresh start`,
      baseline: "record the process id, start time, and relevant bytes before the change",
      kind: "process",
      confirmed: false,
      source: "process heuristic",
    }
  }
  if (args.shape === "fix") {
    return {
      observable: "the reported defect reproduces before the change and no longer reproduces after it",
      baseline: "run the smallest reproduction once and save its output",
      kind: "command",
      confirmed: false,
      source: "fix heuristic",
    }
  }
  if (args.shape === "migrate" || args.shape === "batch") {
    return {
      observable: "the project validator passes on the migrated tree",
      baseline: "run the validator on the current tree and save the count of mismatches",
      kind: "command",
      confirmed: false,
      source: "migration heuristic",
    }
  }
  return {
    observable: `one command supports or refutes the leading hypothesis about ${args.target}, and its raw output is posted`,
    baseline: "run the leading check once and save the raw output",
    kind: "command",
    confirmed: false,
    source: "research heuristic",
  }
}

/** An explicit agent count wins: 50+ lanes are a valid attacking shape. */
function explicitAgentCount(brief: string): number | undefined {
  const match = brief.match(/\b(\d{1,3})\s*(?:x\s*)?(?:agents?|attackers?|workers?|lanes?|threads?|parallel)\b/i)
  if (match) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value >= 2) return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Crew size and confidence
// ---------------------------------------------------------------------------

function estimateAgents(args: {
  simple: boolean
  shape: Shape
  lanes: number
  hypotheses: number
  brief: string
  fileCount: number | undefined
}): number {
  const explicit = explicitAgentCount(args.brief)
  if (explicit !== undefined) return Math.min(500, Math.max(2, explicit))
  if (args.simple) return 2
  let agents = 3
  if (args.lanes >= 3) agents += 1
  agents += Math.min(1, Math.max(0, args.hypotheses - 1))
  if (MULTI_SYSTEM.test(args.brief)) agents += 1
  if (args.shape === "migrate" || args.shape === "batch") {
    const count = args.fileCount ?? 0
    if (count >= 100) return 32
    if (count >= 50) return 16
    if (count >= 20) return 8
    agents = Math.max(agents, 4)
  }
  // An aggressive fan-out is explicit ("50 attackers") or it stays small.
  // Six agents for three routes was the Acrobat failure; do not repeat it.
  return Math.min(4, Math.max(2, agents))
}

function countSignals(args: {
  contract: ProblemContract
  brief: string
  objective: string
  shape: Shape
  race: boolean
  deliverables: string[]
  fileCount: number | undefined
  lanes: number
}): number {
  let signals = 0
  if (args.contract.verificationCommand) signals += 1
  if (args.contract.successCriteria.length > 0) signals += 1
  if (args.contract.constraints.length > 0) signals += 1
  if (args.deliverables.length >= 2) signals += 1
  if (args.fileCount !== undefined && args.fileCount >= 3) signals += 1
  if (args.race) signals += 1
  if (args.lanes >= 4) signals += 1
  if (/\b(?:machine|installed|locally|offline|this (?:box|host|machine)|version)\b/.test(args.brief)) signals += 1
  if (args.objective.length > 100) signals += 1
  if (args.shape === "research" || args.shape === "audit") signals += 1
  return signals
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SameRoleSuggestion {
  role: string
  reason: string
}

/**
 * Infer the independent same-role form when the brief does not say a role or
 * write a crew. It is a heuristic, but a conservative one: one target with an
 * unknown route (research, audit, a single-artifact fix, a race) benefits from
 * several peers working the whole problem; multi-deliverable work does not.
 */
export function suggestSameRole(contract: ProblemContract, analysis: BriefAnalysis): SameRoleSuggestion | undefined {
  if (analysis.shape === "migrate" || analysis.shape === "batch") return undefined
  const text = `${contract.objective}\n${contract.context ?? ""}`.toLowerCase()
  const implementLanes = analysis.workstreams.filter((lane) => lane.kind === "implement")
  const multiDeliverable =
    analysis.shape !== "research" &&
    analysis.shape !== "audit" &&
    implementLanes.length >= 2 &&
    implementLanes.some((lane) => lane.owns.length > 0)
  if (multiDeliverable) return undefined

  const independent =
    analysis.shape === "research" ||
    analysis.shape === "audit" ||
    analysis.shape === "fix" ||
    analysis.coordination === "race" ||
    /\b(?:prove|investigat|diagnos|root cause|why|unlock|bypass|crack|patch|reverse|binary|dll|exe|activation|license|security|attack|exploit|vulnerab)\b/.test(
      text,
    )
  if (!independent) return undefined

  const role =
    /\b(?:adobe|acrobat|binary|dll|exe|reverse|disassembl|unlock|crack|patch|license|activation|firmware)\b/.test(text)
      ? "Reverse Engineer"
      : /\b(?:security|attack|exploit|vulnerab|pentest|red team|malware)\b/.test(text)
        ? "Security Researcher"
        : analysis.shape === "audit"
          ? "Auditor"
          : /\b(?:data|analyz|analys|metric|research|investigat|why|prove|root cause)\b/.test(text)
            ? "Researcher"
            : /\b(?:ui|ux|frontend|css|design|layout)\b/.test(text)
              ? "Frontend Engineer"
              : analysis.shape === "research"
                ? "Researcher"
                : "Software Engineer"

  const reason =
    analysis.shape === "research" || analysis.shape === "audit"
      ? "one research target, unknown route; independent peers beat a divided committee"
      : analysis.shape === "fix"
        ? "single-artifact fix; independent attempts converge faster than lane handoffs"
        : "race-shaped brief; independent peers can attack the same target without a lane split"
  return { role, reason }
}

/**
 * One installed host target has one launch slot. Three independent seats then
 * spend their time on lease/lock contention, not on parallel work. Keep the
 * default at two for this shape; an explicit `--agents N` still overrides it.
 */
export function isSerializedTarget(contract: ProblemContract, analysis: BriefAnalysis): boolean {
  if (analysis.shape === "migrate" || analysis.shape === "batch") return false
  const text = `${contract.objective}\n${contract.context ?? ""}`.toLowerCase()
  if (/\b(?:parallel|independent surfaces|50|fifty|many targets|multiple hosts)\b/.test(text)) return false
  return /\b(?:installed|single target|one target|one binary|one process|one gui|launch slot|window title|registry|\.exe\b|\.dll\b|service|crack|activation|license|trial|bypass)\b/.test(
    text,
  )
}

export function analyzeBrief(contract: ProblemContract): BriefAnalysis {
  const objective = squash(contract.objective)
  const brief = briefText(contract)
  const fileCount = fileCountFrom(objective)
  const deliverables = extractDeliverables(objective)
  const scope = extractScope(objective)
  const target = extractTarget(objective)
  const shape = detectShape(brief, objective, fileCount)
  const race = detectRace(brief)
  const splitReasons = detectSplitReasons(brief, fileCount, deliverables)
  const split = splitReasons.length > 0
  // A race is for independent surfaces. When every "attempt" writes or launches
  // one installed resource, parallel launches collide and the field spends its
  // time on lease fights. Mark the lanes split so the lane rule serializes them.
  const mutableTarget =
    /\b(?:installed|machine|host|process|launch|registry|binary|dll|exe|service|port|socket|display|window|app)\b/i.test(
      brief,
    )
  const coordination: CoordinationMode = race && !mutableTarget ? (split ? "hybrid" : "race") : "split"
  const simple = isSimpleFix({ shape, brief, objective, scope, deliverables, race, split, fileCount })
  const attemptCount = race ? clampInt(explicitAttempts(brief) ?? 3, 2, 4) : 0

  let plan: LanePlan
  if (simple) plan = simplePlan(target, scope, contract.verificationCommand)
  else if (race) plan = racePlan(brief, shape, target, attemptCount, contract.verificationCommand)
  else if (shape === "audit") plan = auditPlan(contract.verificationCommand)
  else if (shape === "research") plan = researchPlan(target, contract.verificationCommand)
  else if (shape === "migrate" || shape === "batch") plan = migratePlan(fileCount, deliverables)
  else if (deliverables.length >= 2) plan = splitPlan(deliverables, contract.verificationCommand)
  else if (shape === "fix") plan = fixPlan(scope, contract.verificationCommand)
  else plan = buildPlan(deliverables, contract.verificationCommand)

  const workstreams = plan.workstreams
  const recommendedRoles = unique(plan.roles)

  let hypotheses: BriefHypothesis[]
  if (simple) hypotheses = simpleFixHypotheses(target, contract.verificationCommand)
  else if (race) hypotheses = researchHypotheses(target, true, contract.verificationCommand)
  else if (shape === "research") hypotheses = researchHypotheses(target, false, contract.verificationCommand)
  else if (shape === "audit") hypotheses = auditHypotheses(contract.verificationCommand)
  else if (shape === "migrate" || shape === "batch") hypotheses = migrateHypotheses(fileCount, contract.verificationCommand)
  else if (shape === "fix") hypotheses = fixHypotheses(scope, contract.verificationCommand)
  else hypotheses = buildHypotheses(deliverables)

  const recommendedAgents = estimateAgents({
    simple,
    shape,
    lanes: workstreams.length,
    hypotheses: hypotheses.length,
    brief,
    fileCount,
  })

  const rawSignals = countSignals({ contract, brief, objective, shape, race, deliverables, fileCount, lanes: workstreams.length })
  const confidence: Confidence = rawSignals >= 3 ? "high" : rawSignals === 2 ? "medium" : "low"

  const doneWhen = buildDoneWhen({
    shape,
    brief,
    target,
    scope,
    fileCount,
    verificationCommand: contract.verificationCommand,
  })
  const negativeWhen = buildNegativeWhen(shape, target)
  const oracle = buildOracle({ shape, brief, target, verificationCommand: contract.verificationCommand })

  const reasons: string[] = []
  reasons.push(`${shape} brief: ${coordination} coordination across ${workstreams.length} lane(s)`)
  if (race) {
    reasons.push(
      `${workstreams.filter((lane) => lane.kind === "attack").length} attempt lane(s) share one target (${target}); ${
        mutableTarget ? "the installed target serializes launches and writes" : "independent routes beat one serial guess"
      }`,
    )
  } else if (deliverables.length >= 2) {
    reasons.push(`${deliverables.length} independent deliverables: each lane owns a disjoint area`)
  } else if (simple) {
    reasons.push("one focused lane plus an independent verifier is the whole job")
  } else {
    reasons.push("no race signal: serial lanes avoid duplicate work")
  }
  reasons.push(
    `${recommendedAgents} agent(s) for ${hypotheses.length} time-boxed hypothesis(es)${contract.verificationCommand ? " and a declared verification command" : " and observable verification"}`,
  )
  reasons.push(`oracle: ${oracle.observable.slice(0, 120)}`)
  if (confidence !== "high") reasons.push(`confidence ${confidence}: ${rawSignals} discriminating signal(s) in the brief`)

  return {
    shape,
    coordination,
    workstreams,
    hypotheses: hypotheses.slice(0, 4),
    oracle,
    doneWhen,
    negativeWhen,
    recommendedAgents,
    recommendedRoles,
    confidence,
    reasons: reasons.slice(0, 5),
  }
}
