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
 * never a decline — that difference is what keeps the run retryable. The config the
 * mode is read from is `ready`'s, already loaded by its setup check (`ready-setup.ts`),
 * so a config nobody could read never reaches this decision. A mode value the switch
 * refuses is the repo's own defect and declines, naming the knob. The mode itself is
 * `spec-intake-switch.ts`'s: env, then the committed `lean.specIntake`, then `require`.
 */

import { resolveModel } from "../models.ts";
import type { WorkConfig } from "./config.ts";
import type { LeanSeed } from "./seed.ts";
import {
  type DeriveDeps,
  type DeriveOutcome,
  SpecDeriveError,
  deriveSpecForRun,
  traceDerive,
} from "./spec-derive.ts";
import { type SpecIntake, SpecIntakeError, resolveSpecIntake } from "./spec-intake-switch.ts";
import type { PiSpec } from "./spec.ts";
import { parsePiSpec } from "./spec.ts";
import type { DerivedSpec } from "./state-derived-spec.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";

/** The text a prose ticket's missing block is reported as, in both modes. */
export const NO_BLOCK_RULE = "no pi-spec v1 block";

/** What the decision came to: a contract, or the rule that stopped the run. Either may
 * carry the cost rows of a child the intake paid for; neither does when none was billed. */
export type Contract =
  | { spec: PiSpec; derived?: DerivedSpec; dispatches: DispatchUsageRow[] }
  | { rule: string; infra?: boolean; dispatches?: DispatchUsageRow[] };

/** Decide the run's contract from its issue body and the run's config at its base.
 * `derive` is optional because the derivation needs the run's wiring (forge read, child
 * dispatch): a caller with no deps in hand gets `require`'s answer, and nothing is
 * missed because the mode is checked before the deps are used. */
export async function contractOf(
  repoRoot: string,
  issue: number,
  body: string,
  base: Pick<LeanSeed, "baseSha"> & { specIntake?: SpecIntake },
  config: WorkConfig,
  derive?: DeriveDeps,
): Promise<Contract> {
  const parsed = parsePiSpec(body);
  if (parsed.ok) return { spec: parsed.spec, dispatches: [] };
  if (parsed.reason !== NO_BLOCK_RULE) return { rule: parsed.reason };
  let intake: SpecIntake;
  try {
    intake = resolveSpecIntake(config, base.specIntake);
  } catch (err) {
    if (!(err instanceof SpecIntakeError)) throw err;
    // The repo's defect, not infrastructure: a knob set to a value it cannot mean is
    // the author's mistake, so it declines and says so rather than handing back.
    return { rule: oneLine(err.message, 240) };
  }
  if (intake !== "derive" || derive === undefined) return { rule: NO_BLOCK_RULE };
  // A blank ticket is not "prose to derive from": decline, and bill no child for a
  // blank page a model would fill in from the title.
  if (body.trim() === "") return { rule: NO_BLOCK_RULE };
  try {
    const derived = await deriveSpecForRun(derive, repoRoot, issue, base.baseSha, body);
    return {
      spec: derived.spec,
      derived: {
        spec: derived.spec,
        model: deriveModel(),
        at: Date.now(),
        ...(derived.guards === undefined ? {} : { guards: derived.guards }),
      },
      dispatches: derived.dispatches,
    };
  } catch (err) {
    if (!(err instanceof SpecDeriveError)) throw err;
    traceDerive(issue, "refused", err.message);
    // A ticket with nothing to build is the issue's fault: a decline, not a handback.
    if (err.decline === true) return { rule: err.message, dispatches: err.dispatches ?? [] };
    // Clipped: the cause is a model's text put into a rule the operator reads verbatim.
    // The child's rows ride on the handback: a child that died still spent tokens.
    return {
      rule: `spec derivation failed: ${oneLine(err.message, 240)}`,
      infra: true,
      dispatches: err.dispatches ?? [],
    };
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
