/**
 * The claim gate — the only way a field finishes successfully.
 *
 * A claim is accepted when the declared verification passed (and actually ran),
 * no peer falsified it, and it carries evidence. Anything else is rejected with
 * a reason the claimer can act on.
 */

export interface ClaimGateInput {
  claim: { label: string; text: string; evidence: string[]; coverage?: string[] }
  attempts: number
  hasCommand: boolean
  verification?: { ok: boolean; output: string }
  falsifier?: { falsified: boolean; reason: string; test?: string }
  maxAttempts: number
}

export interface ClaimGateResult {
  accepted: boolean
  final: boolean
  reason: string
}

function finality(accepted: boolean, attempts: number, maxAttempts: number): boolean {
  return !accepted && attempts + 1 >= maxAttempts
}

export function judgeClaim(input: ClaimGateInput): ClaimGateResult {
  const { claim, attempts, hasCommand, verification, falsifier, maxAttempts } = input
  const coverage = (claim.coverage ?? []).map((item) => item.trim()).filter(Boolean)
  if (coverage.length > 0) {
    if (claim.evidence.length === 0) {
      return {
        accepted: false,
        final: finality(false, attempts, maxAttempts),
        reason: "a coverage claim needs evidence for the part that was proven",
      }
    }
    if (falsifier?.falsified) {
      return {
        accepted: false,
        final: finality(false, attempts, maxAttempts),
        reason: `a peer falsified the coverage: ${falsifier.reason}`,
      }
    }
    return {
      accepted: true,
      final: false,
      reason: `coverage accepted: ${coverage.length} item(s) named, including the boundary`,
    }
  }
  if (hasCommand && !verification) {
    return {
      accepted: false,
      final: finality(false, attempts, maxAttempts),
      reason: `the declared verification did not run; run it and post the real output`,
    }
  }
  if (hasCommand && verification && !verification.ok) {
    const tail = verification.output.replace(/\s+/g, " ").trim().slice(0, 300)
    return {
      accepted: false,
      final: finality(false, attempts, maxAttempts),
      reason: `verification failed: ${tail || "the command exited non-zero"}`,
    }
  }
  if (falsifier?.falsified) {
    const test = falsifier.test ? ` (${falsifier.test})` : ""
    return {
      accepted: false,
      final: finality(false, attempts, maxAttempts),
      reason: `a peer falsified the claim${test}: ${falsifier.reason}`,
    }
  }
  if (!hasCommand && claim.evidence.length === 0) {
    return {
      accepted: false,
      final: finality(false, attempts, maxAttempts),
      reason: `no evidence: post the commands and output that support the claim`,
    }
  }
  return { accepted: true, final: false, reason: falsifier?.reason ? `not falsified: ${falsifier.reason}` : "verified" }
}
