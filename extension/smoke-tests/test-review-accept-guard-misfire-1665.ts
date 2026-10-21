#!/usr/bin/env bun
/**
 * #1665 / #1643 / #1578 — the guard misfires measured on a live host, and the
 * store-reaching shapes that must stay refused beside them.
 *
 * The invariant this suite exists to hold: the findings-store refusal is the guard's
 * ONLY message, so it may fire only for a command that actually reaches the findings
 * store or runs the operator's accept script (#1665's "Done when"). A command that
 * spells no protected name and points no repo-location selector at the store's
 * directory is an ordinary agent command — including `git -C <worktree>`, which
 * AGENTS.md itself mandates (#1643), a heredoc into an ordinary file, and any argument
 * merely carrying a backslash (`echo -e`, `printf`, a `grep` BRE, a `gh --jq` filter).
 *
 * The refusal text is asserted too: every refusal this guard issues must name the
 * findings store, because that is the only thing it is allowed to refuse.
 */
import { runsReviewAccept } from "../src/review-accept-guard.ts";
import {
  MEASURED_MISFIRES_ALLOWED,
  STORE_REACHING_REFUSALS,
} from "./review-accept-guard-misfire-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const verdict = (c: string): string | undefined => runsReviewAccept(c);
const refused = (c: string): boolean => verdict(c) !== undefined;

for (const t of MEASURED_MISFIRES_ALLOWED) {
  const reason = verdict(t.c);
  assert(
    reason === undefined,
    `measured misfire stays allowed — ${t.why}${reason ? ` (refused: ${reason.slice(0, 60)}…)` : ""}`,
  );
}

for (const t of STORE_REACHING_REFUSALS) {
  const reason = verdict(t.c);
  assert(reason !== undefined, `store-reaching shape refused — ${t.why}`);
  // #1665: the findings-store sentence is the guard's whole vocabulary, so it must
  // appear ONLY where the store is genuinely in the sight line.
  assert(
    (reason ?? "").includes("review findings store") &&
      (reason ?? "").includes("extension/scripts/review-accept.ts"),
    `refusal names the store and the sanctioned CLI — ${t.why}`,
  );
}

process.exit(exit);
