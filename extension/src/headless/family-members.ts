/**
 * headless/family-members — the member rosters a family-shaped `PI_ENSEMBLE_*`
 * name expands to, for the `--capabilities` answer (#1326).
 *
 * `headless/inputs.ts` lists every honoured env input; a name containing
 * `<ROLE>`, `<SEAM>` or `<LENS>` is a family and its `members` field carries
 * the ids the build actually reads, so the list cannot drift from the role,
 * seam and lens registries behind them. Those three rosters are this module —
 * split out of `inputs.ts` (AGENTS.md §12) because the env list there is data
 * at scale and the two have different shapes and different reasons to change.
 *
 * Each roster is derived, never copied: `SUBAGENT_ROLE_NAMES`, the seam
 * registry and `LENS_ROSTER` are the authorities, so a role or lens added
 * there is a member here without an edit in this file.
 */

import { SEAMS, isGrandfathered } from "../decision-seam-registry.ts";
import { LENS_ROSTER } from "../lens-roster.ts";
import { SUBAGENT_ROLE_NAMES } from "../roles.ts";

/** A role, seam or lens name as it appears in an env name. */
export const envId = (id: string) => id.toUpperCase().replaceAll("-", "_");

/** `<ROLE>`: every spawned role; the parent session takes no per-role env. */
export const ROLE_MEMBERS: readonly string[] = SUBAGENT_ROLE_NAMES.map(envId);

/** `<SEAM>`: every registered seam that reads its env config. */
export const SEAM_MEMBERS: readonly string[] = Object.values(SEAMS)
  .filter((s) => !isGrandfathered(s))
  .map((s) => envId(s.id))
  .sort();

/** `<LENS>`: the bundled lenses (lens-roster.ts), in roster order. */
export const LENS_MEMBERS: readonly string[] = [...new Set(LENS_ROSTER.map((e) => e.name))];
