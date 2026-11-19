/**
 * lib/forge-read-duplicate-mutant — the RED half of the #2382 single-owner
 * contract, kept beside the collector it loads into.
 *
 * A new gate must be observed failing, so `test-child-forge-read-single-owner.ts`
 * judges its shape twice: once against the shipped registration (which must count
 * 1) and once against the duplicate built here (which must count 2). The mutant
 * restores the pre-#2382 owner argument that the two child entry points carried
 * and hands it to the REAL registration function, so the tool under test stays
 * the shipped one and only the number of registrations changes — a mutant that
 * wrote its own tool would pass while the real registration broke.
 *
 * `assertMutantIsPreFixShape` is what keeps the red honest: if the tree drifts so
 * that the mutant is no longer the pre-#2382 shape, the row fails loudly instead
 * of going quietly green.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildForgeReadTool } from "../../src/child-forge-read-activation.ts";

/** The registration owner the pre-#2382 signature required. */
type ForgeReadRegistrationOwner = "companion" | "forwarded-extension";

/**
 * The pre-#2382 registration: the owner argument those two sites carried, in
 * front of the REAL registration function. Both entry points registered — the
 * companion always, and `registerSubagentGuard` (the forwarded full extension)
 * too, because its call sat ABOVE that function's sandbox and trust
 * short-circuits and so ran in every mode, including the strict/headless one that
 * broke. That is why the strict arm must count 2. `from` stays in the signature
 * because the shipped code had it; the mode is not consulted, because standing
 * the forwarded extension down inside a forwarded child is the very behaviour the
 * fix removed, and a mutant that reproduced it would be a copy of the fix, not of
 * the bug.
 */
function registerAsOwner(pi: ExtensionAPI, _from: ForgeReadRegistrationOwner): void {
  registerChildForgeReadTool(pi);
}

/** The forwarded full extension's child entry point, as it registered pre-#2382. */
export function duplicateSubagentGuardEntry(pi: ExtensionAPI): void {
  registerAsOwner(pi, "forwarded-extension");
}

/** The companion, as it registered pre-#2382 (and as it still does). */
export function duplicateCompanionEntry(pi: ExtensionAPI): void {
  registerAsOwner(pi, "companion");
}

/** The shapes that define the mutant: the owner call the forwarded site carried, and the unowned registrations of the shipped sites. */
const SOURCE = {
  // The pre-#2382 forwarded site: the registration itself plus the value import
  // that loaded the module. A value import is a side-effectful load and the module
  // registers its tool at call time, so an import left behind after the call was
  // deleted is how a second `forge_read` gets back into the strict child.
  subagentGuardCall: "registerChildForgeReadTool(pi",
  subagentGuardImport: "import { enableChildForgeRead, registerChildForgeReadTool }",
  companionCall: "registerChildForgeReadTool(pi)",
  mutantRegister: "function registerAsOwner(pi: ExtensionAPI, _from: ForgeReadRegistrationOwner)",
} as const;

/** The files the mutant's shape is defined against, relative to this lib/ file. */
const FILES = {
  subagentGuard: "../../src/permission-subagent-guard.ts",
  companion: "../../src/child-guards.ts",
  activation: "../../src/child-forge-read-activation.ts",
} as const;

export interface MutantDrift {
  ok: boolean;
  /** Which expected shape the tree no longer matches (empty when ok). */
  missing: string;
}

/**
 * Whether the tree still carries the shape this mutant reproduces: the forwarded
 * extension registers nothing, the companion still registers through the shared
 * function, the owner predicate is gone from it, and this file still carries the
 * predicate it restores. Any half going quiet means the mutant is no longer the
 * mutant — which would turn the red row into a lie, so it is a failed row.
 */
export async function assertMutantIsPreFixShape(): Promise<MutantDrift> {
  const here = fileURLToPath(import.meta.url);
  const read = (rel: string): string =>
    readFileSync(rel.startsWith("/") ? rel : fileURLToPath(new URL(rel, `file://${here}`)), "utf8");
  const files = {
    subagentGuard: read(FILES.subagentGuard),
    companion: read(FILES.companion),
    activation: read(FILES.activation),
    mutant: read(here),
  };
  const checks: Array<[string, boolean]> = [
    [
      "the forwarded extension neither registers nor imports the registration",
      !files.subagentGuard.includes(SOURCE.subagentGuardCall) &&
        !files.subagentGuard.includes(SOURCE.subagentGuardImport),
    ],
    [
      "the companion still registers through the shared function",
      files.companion.includes(SOURCE.companionCall),
    ],
    [
      "the shipped registration takes no owner argument (so the mutant is the whole difference)",
      files.activation.includes("export function registerChildForgeReadTool(pi: ExtensionAPI)") &&
        !files.activation.includes("ForgeReadRegistrationOwner"),
    ],
    [
      "this mutant still registers every entry point it is handed (the pre-#2382 shape)",
      files.mutant.includes(SOURCE.mutantRegister),
    ],
  ];
  const failed = checks.find(([, held]) => !held);
  return failed ? { ok: false, missing: failed[0] } : { ok: true, missing: "" };
}
