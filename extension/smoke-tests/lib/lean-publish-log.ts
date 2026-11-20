/*
 * lib/lean-publish-log — the step log a fixture run carries into `publish`.
 *
 * Split out of `lib/lean-publish-fixture.ts` under the §12 file-size cap, along the
 * seam of what a run's HISTORY is, as against what origin holds
 * (`lean-publish-remote-seeds.ts`) or what one call answers (`lean-publish-seams.ts`).
 *
 * A lean run reaches `publish` with a `ready`, a `build` and a green `verify` behind it;
 * those three are what `logFor` writes, and a case changes the verdict rather than the
 * shape. `priorPublishStep` adds the fourth entry a republish meets — the run's own
 * earlier `publish`, DECIDED, which is the record the own-PR exemption reads. Both
 * builders take the values the case named rather than inventing their own, so a step
 * never says something the fixture did not arrange: `priorPublishStep`'s head is the sha
 * the fixture left origin holding, which is why the record and the remote are one fact
 * in two readings rather than two that happen to agree.
 */

import type { PreexistingTierRecord } from "../../src/lean/state-outcome-maps.ts";
import type { Step } from "../../src/lean/state.ts";
import { sha } from "./lean-verify-fixture.ts";

/** The acceptance test the run froze, committed at HEAD (the fixture writes the file). */
/** The acceptance test the run froze, committed at HEAD (the fixture writes the file). */
export const TEST_FILE_CONTENT = "#!/bin/sh\nexit 0\n";

/** The step log a run carries when it reaches publish with a green gate. */
export function logFor(
  issue: number,
  o: {
    verify?: { kind: "green" | "red"; head?: string; reason?: string } | undefined;
    commandCriteria?: Record<string, string>;
    preexistingFailures?: Record<string, PreexistingTierRecord>;
    extraSteps?: Step[];
  },
  head: string,
): Step[] {
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    // The frozen contract, recorded where the run recorded it: `publish`'s body reads
    // each criterion's test paths off THIS entry (`testsFromLog`), so a log without it
    // would print an empty `tests` column and no case could see the table is real.
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen: {
          "tests/AC1-retry.test.sh": sha(TEST_FILE_CONTENT),
          "tests/AC2-bound.test.sh": sha(TEST_FILE_CONTENT),
        },
        tests: { AC1: ["tests/AC1-retry.test.sh"], AC2: ["tests/AC2-bound.test.sh"] },
      },
    },
    {
      key: `${issue}:build:0`,
      state: "build",
      startedAt: 3,
      outcome: { kind: "ok", reason: "1 file(s) changed" },
    },
  ];
  if (o.verify !== undefined) {
    steps.push({
      key: `${issue}:verify:0`,
      state: "verify",
      startedAt: 4,
      outcome: {
        kind: o.verify.kind,
        ...(o.verify.reason === undefined ? {} : { reason: o.verify.reason }),
        ...(o.verify.kind === "green" ? { verifiedHead: o.verify.head ?? head } : {}),
        ...(o.commandCriteria === undefined ? {} : { commandCriteria: o.commandCriteria }),
        ...(o.preexistingFailures === undefined
          ? {}
          : { preexistingFailures: o.preexistingFailures }),
      },
    });
  }
  return [...steps, ...(o.extraSteps ?? [])];
}

/**
 * The DECIDED `publish` step a republish meets: the run published `head`, the forge
 * answered with `prUrl`, and origin has held that sha ever since.
 */
export function priorPublishStep(issue: number, prior: { prUrl: string }, head: string): Step[] {
  return [
    {
      key: `${issue}:publish:0`,
      state: "publish",
      startedAt: 5,
      endedAt: 6,
      outcome: {
        kind: "ok",
        prUrl: prior.prUrl,
        draft: false,
        publishedHead: head,
        reason: `published PR ${prior.prUrl} at ${head.slice(0, 12)}`,
      },
    },
  ];
}
