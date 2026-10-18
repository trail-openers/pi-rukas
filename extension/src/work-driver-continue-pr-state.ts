/**
 * work-driver-continue-pr-state — #1468: what `--continue-pr` records about
 * the PR it continues. `headSha` is the PR head at the start (P);
 * `mainlineSha` is the main commit the cycle judges against (M).
 */

import type { OpenPrMatch } from "./work-driver-pr-preflight.ts";

export type ContinuedPr = {
  number: number;
  headRefName: string;
  headSha: string;
  mainlineSha: string;
  conflictPaths: string[];
  matchedBy: OpenPrMatch["matchedBy"];
};
