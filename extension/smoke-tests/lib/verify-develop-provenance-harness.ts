/**
 * lib/verify-develop-provenance-harness — drive the develop gate's data-provenance check
 * over a real repository, from one call.
 *
 * Split out of `test-verify-develop-data-provenance.ts` for the 500-line cap, along the seam
 * that was already a helper rather than a case: building a fixture and handing the gate three
 * empty out-channels is setup, and the judgement about what an outcome MEANS is what the
 * suites assert. Two suites now share it — the behaviour suite and the bounds suite — so the
 * fixture they disagree about cannot differ in a way only one of them can see.
 *
 * The gate's whole claim is that it judges the committed tree, so everything below still goes
 * to real git through the shared fixture; only the project's own verify command is scripted.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { rmSync } from "node:fs";
import type { VerifyDevelopOutcomeOptions } from "../../src/work-driver-verify-develop-options.ts";
import {
  PROVENANCE_FAILURE_PREFIX,
  type ProvenanceDisclosure,
} from "../../src/work-driver-verify-develop-provenance.ts";
import { verifyDevelopOutcome } from "../../src/work-driver-verify-develop.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./verify-develop-provenance-fixture.ts";

/** The three out-channels a drive produced: what failed, what was said, what was disclosed. */
export interface ProvenanceDrive {
  failures: string[];
  notes: string[];
  disclosures: ProvenanceDisclosure[];
}

/** Build a repo whose develop commit adds `files`, then judge it. `verifyCommand` is the
 * project's own command and is scripted, never executed — every git read is real. */
export async function makeProvenanceFixtureWith(
  files: Record<string, string>,
  verifyCommand = "true",
): Promise<ProvenanceFixture> {
  return makeProvenanceFixture({ issue: 2283, developFiles: files, verifyCommand });
}

/** Drive the develop gate over a fixture, returning the gate's own three out-channels. The
 * disclosure sink is handed in and read back, exactly as the driver hands it in. */
export async function driveProvenance(
  f: ProvenanceFixture,
  options: VerifyDevelopOutcomeOptions = {},
): Promise<ProvenanceDrive> {
  const failures: string[] = [];
  const notes: string[] = [];
  const sink: { disclosures?: ProvenanceDisclosure[] } = { disclosures: [] };
  await verifyDevelopOutcome(f.ctxFor(), f.stateFor(), f.execFn, failures, notes, {
    ...options,
    provenanceDisclosures: sink,
  });
  return { failures, notes, disclosures: sink.disclosures ?? [] };
}

/** Drive a fixture in one call, cleaning up either way. A case that asserts and then forgets
 * to `rm` leaks a repository per assertion into the scratch root. */
export async function driveProvenanceFixture(
  files: Record<string, string>,
  options: VerifyDevelopOutcomeOptions = {},
): Promise<ProvenanceDrive> {
  const f = await makeProvenanceFixtureWith(files);
  try {
    return await driveProvenance(f, options);
  } finally {
    rmProvenanceFixture(f);
  }
}

/** This gate's own rows out of a failure list — so a case never counts another develop gate's
 * failure as a provenance verdict, and never lets one of these hide among others. */
export function provenanceFailures(failures: readonly string[]): string[] {
  return failures.filter((f) => f.includes(PROVENANCE_FAILURE_PREFIX));
}

/** Remove a drive's scratch tree. */
export function rmProvenanceFixture(f: ProvenanceFixture): void {
  rmSync(f.root, { recursive: true, force: true });
}
