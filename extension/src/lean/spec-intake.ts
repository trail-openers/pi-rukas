/**
 * lean/spec-intake — where a run's contract comes from.
 *
 * `ready` used to have one answer (the issue body, or nothing) and it lived inline
 * in `command.ts`. It has two now, and the decision is load-bearing enough to sit
 * alone: it is where a run chooses between quoting a human's document and paying a
 * model to draft one. The rule: a block that PARSES always wins; a block present
 * but malformed is reported exactly as `require` reports it in both modes (the
 * author took a position and wrote it wrong — a model quietly writing a better one
 * would hide the defect); a body with NO block is where the switch applies, with
 * `require` declining byte-for-byte as before and `derive` sending the prose to one
 * bounded child, unless the body is blank, which is a ticket with nothing in it and
 * is declined without billing a child. A failed derivation is an `infra` verdict,
 * never a decline — that difference is what keeps the run retryable. The mode
 * itself is `spec-intake-switch.ts`'s: env, then the committed `lean.specIntake`,
 * then `require`.
 */

import { execp } from "../exec.ts";
import { resolveModel } from "../models.ts";
import { type WorkConfig, loadWorkConfig } from "./config.ts";
import type { LeanSeed } from "./seed.ts";
import { type DeriveDeps, SpecDeriveError, deriveSpecForRun, traceDerive } from "./spec-derive.ts";
import { type SpecIntake, resolveSpecIntake } from "./spec-intake-switch.ts";
import type { PiSpec } from "./spec.ts";
import { parsePiSpec } from "./spec.ts";
import type { DerivedSpec } from "./state-derived-spec.ts";
import { oneLine } from "./text-fence.ts";

/** The text a prose ticket's missing block is reported as, in both modes. */
export const NO_BLOCK_RULE = "no pi-spec v1 block";

/** What the decision came to: a contract, or the rule that stopped the run. */
export type Contract = { spec: PiSpec; derived?: DerivedSpec } | { rule: string; infra?: boolean };

/** Decide the run's contract from its issue body. `derive` is optional because the
 * derivation needs the run's wiring (forge read, child dispatch): a caller with no deps
 * in hand — a case, or a run whose mode resolves to `require` — gets today's behaviour,
 * and nothing is missed because the mode is checked before the deps are used. */
export async function contractOf(
  repoRoot: string,
  issue: number,
  body: string,
  base: Pick<LeanSeed, "baseSha">,
  derive?: DeriveDeps,
): Promise<Contract> {
  const parsed = parsePiSpec(body);
  if (parsed.ok) return { spec: parsed.spec };
  if (parsed.reason !== NO_BLOCK_RULE) return { rule: parsed.reason };
  // Env first (the operator's word), then the committed `lean.specIntake`, then
  // `require` — so a repo that sets `derive` in `.pi/work.json` is read before its prose
  // is derived from. The read is at the run's base and NON-FATAL: the fallback stays
  // `require` and `readyOutcome`'s own full read still reports a broken config, so an
  // unreadable config neither silently arms a derivation nor loses that error.
  const config =
    base.baseSha === ""
      ? undefined
      : await loadWorkConfig(execp, repoRoot, base.baseSha).catch(() => undefined);
  const intake: SpecIntake = resolveSpecIntake(config);
  if (intake !== "derive" || derive === undefined) return { rule: NO_BLOCK_RULE };
  // A blank ticket is not "prose to derive from": decline, and bill no child for a
  // blank page a model would fill in from the title.
  if (body.trim() === "") return { rule: NO_BLOCK_RULE };
  try {
    const spec = await deriveSpecForRun(derive, repoRoot, issue, base.baseSha, body);
    return { spec, derived: { spec, model: deriveModel(), at: Date.now() } };
  } catch (err) {
    if (!(err instanceof SpecDeriveError)) throw err;
    traceDerive(issue, "refused", err.message);
    // Clipped: the derivation's cause is a model's text put into a rule an
    // operator reads verbatim on the issue's handback comment.
    return { rule: `spec derivation failed: ${oneLine(err.message, 240)}`, infra: true };
  }
}

/** The model the deriving child will be resolved to, for the record's provenance.
 * Resolution is the run's own — role env, config, the global default — so the record
 * names the model that actually drafted the contract. `""` is honest for the shipped
 * default, where none is configured: a fabricated name would mislead the operator
 * reading back a bad derivation. */
export function deriveModel(): string {
  try {
    return resolveModel("explore").model ?? "";
  } catch {
    return "";
  }
}
