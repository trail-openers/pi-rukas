/**
 * headless/entry — the `HostInput` shape, the builders that produce its rows,
 * and the family member lists, for the `--capabilities` answer (#1326).
 *
 * Split out of `inputs.ts` (AGENTS.md §12: split, never compress) and left
 * free of any import from its siblings on purpose: the input list there is
 * data at scale and is carried by two modules (`inputs.ts` and
 * `inputs-b.ts`), and both declare their rows with these builders and fill
 * their `<ROLE>` / `<SEAM>` / `<LENS>` families from these lists. Were any of
 * them in `inputs.ts`, that module would import its own second half and the
 * second half would import it back, so the array literal in whichever half
 * ran first would read bindings still in their TDZ.
 */

import { SEAMS, isGrandfathered } from "../decision-seam-registry.ts";
import { LENS_ROSTER } from "../lens-roster.ts";
import { SUBAGENT_ROLE_NAMES } from "../roles.ts";
// The prefix every host input name carries, written once in `prefix.ts` so the
// builders restate nothing.
import { ENV_PREFIX } from "./prefix.ts";

export type InputType =
  | "boolean"
  | "integer"
  | "number"
  | "duration-ms"
  | "string"
  | "path"
  | "list"
  | "enum";

export type InputScope =
  | "cycle"
  | "sandbox"
  | "interactive"
  | "install"
  | "wrapper"
  | "internal"
  | "test";

export interface HostInput {
  name: string;
  type: InputType;
  default: string | number | boolean | null;
  scope: InputScope;
  /** `enum` only: the accepted values. */
  values?: readonly string[];
  /** A family only: the ids its placeholder takes (#1369). */
  members?: readonly string[];
  /** `list` only: the separator between values. */
  separator?: string;
  /** `number` / `integer`: the unit, when not obvious from the name. */
  unit?: "s" | "days" | "tokens" | "turns" | "epoch-ms";
  /** The issue-image manifest format version the input reads (#1306). */
  manifestVersion?: number;
}

export type Opt = Partial<
  Pick<HostInput, "values" | "members" | "separator" | "unit" | "manifestVersion">
>;
export function input(
  name: string,
  type: InputType,
  dflt: HostInput["default"],
  scope: InputScope = "cycle",
  opt: Opt = {},
): HostInput {
  return { name: `${ENV_PREFIX}${name}`, type, default: dflt, scope, ...opt };
}
export const flag = (name: string, dflt: boolean | null, scope?: InputScope) =>
  input(name, "boolean", dflt, scope);
export const ms = (name: string, dflt: number | null, scope?: InputScope) =>
  input(name, "duration-ms", dflt, scope);
export const int = (name: string, dflt: number | null, scope?: InputScope, opt?: Opt) =>
  input(name, "integer", dflt, scope, opt);
export const str = (name: string, dflt: string | null, scope?: InputScope) =>
  input(name, "string", dflt, scope);
export const dir = (name: string, dflt: string | null, scope: InputScope = "install") =>
  input(name, "path", dflt, scope);
export const list = (name: string, separator: string, dflt: string | null, scope?: InputScope) =>
  input(name, "list", dflt, scope, { separator });
export const family = (entry: HostInput, members: readonly string[]): HostInput => ({
  ...entry,
  members,
});

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
