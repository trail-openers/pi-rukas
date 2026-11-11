#!/usr/bin/env bun
/**
 * #2181 A4 — `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1` does not reach the author gate.
 *
 * The escape hatch is an operator's answer to "I reviewed this by other means". It
 * is not an answer to WHO opened the PR, and A4 says so plainly: no override applies
 * to the author rule. Until this fix the hatch returned from `registerMergeGuard`
 * before the hook was registered at all, so the one gate that must survive every
 * switch was the first thing the switch removed — an operator who set it to get one
 * command through silently landed strangers too.
 *
 * Both halves are pinned, because a gate that refuses everybody is not the gate A4
 * asks for:
 *
 *   - hatch SET, author not on the list → refused, naming the login and the file;
 *   - hatch SET, author on the list → not blocked by the author gate at all;
 *   - hatch SET → everything else the hatch disables stays disabled (no forge read).
 */

import { registerMergeGuard } from "../src/merge-guard.ts";
import { mergeGuardExec, type MergeGuardEnv } from "./merge-guard-stub.ts";
import {
  ALLOWED_AUTHOR,
  GOOD_ENTRIES,
  NOT_ALLOWED_AUTHOR,
  TARGET,
  setupLedgerPath,
  teardownLedger,
  withLedger,
} from "./merge-guard-helpers.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Drive the real hook with the hatch set, and restore the env afterwards.
 *
 * The env is what the guard reads at registration time, so it is set BEFORE
 * `registerMergeGuard` — which is exactly where the defect lived.
 */
async function hookDecisionWithHatch(
  entries: typeof GOOD_ENTRIES,
  opts: Partial<MergeGuardEnv> = {},
) {
  const env: MergeGuardEnv = {
    target: opts.target ?? TARGET,
    currentPatchId: opts.patchId ?? "p1",
    fetchedHead: opts.fetchedHead ?? "abc123",
    calls: [] as string[],
    remote: opts.remote ?? "origin",
    ledgerCommonDir: opts.ledgerCommonDir,
    authorAllowlist: opts.authorAllowlist,
    noAllowlist: opts.noAllowlist,
  };
  const prev = process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
  process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE = "1";
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  try {
    registerMergeGuard(
      {
        on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
          if (name === "tool_call") handler = fn;
        },
      } as never,
      { execFn: mergeGuardExec(env) },
    );
    if (!handler) throw new Error("the merge guard registered no tool_call handler");
    const r = (await withLedger(entries, () =>
      handler?.({ toolName: "bash", input: { command: "gh pr merge 12" } }, undefined as never),
    )) as { block?: boolean; reason?: string } | undefined;
    return { block: r?.block === true, reason: r?.reason ?? "", calls: env.calls };
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
    else process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE = prev;
  }
}

await setupLedgerPath();

// ------------------------------------------------- a stranger is refused WITH the hatch set
{
  const stranger = { ...TARGET, author: NOT_ALLOWED_AUTHOR };
  const r = await hookDecisionWithHatch(GOOD_ENTRIES, { target: stranger });
  assert(
    r.block,
    `hatch set: a non-allowlisted author is still refused (${r.reason.slice(0, 90)})`,
  );
  assert(
    r.reason.includes(NOT_ALLOWED_AUTHOR) &&
      r.reason.includes(".pi/merge-authors") &&
      !r.reason.includes(ALLOWED_AUTHOR),
    "…the refusal names the offending login and the gate file, never the allowlisted logins",
  );
}

// ------------------------------------- an allowlisted author is NOT blocked by the author gate
{
  // The other half of A4: the gate must not have been turned into a gate that
  // refuses everything. With the hatch set the reviews are waived, so the ONLY
  // thing left that can refuse this PR is the author gate — and for an allowlisted
  // author that gate allows, so nothing refuses at all.
  const r = await hookDecisionWithHatch(GOOD_ENTRIES, { target: { ...TARGET } });
  assert(
    !r.block,
    `hatch set: an allowlisted author is not blocked by the author gate (${r.reason.slice(0, 90)})`,
  );
  assert(
    !r.reason.includes(".pi/merge-authors"),
    "…and the refusal text never mentions the gate file for an author that is on it",
  );
}

// ------------------------------- everything else the hatch disables stays disabled
{
  // The hatch still means "do not run the review gates": a PR with NO ledger rows
  // merges. That is the behaviour the operator set the switch for, and it is the only
  // arm that separates the author gate from the rest — an allowlisted PR with a full
  // ledger would pass either way. The forge and git reads the gate itself needs are
  // allowed; nothing the review gates make may appear.
  const FORBIDDEN = [
    "patch-id",
    "merge-base",
    "git fetch",
    "mergeStateStatus",
    "--json comments",
    "diff -z",
  ];
  const r = await hookDecisionWithHatch([], { target: { ...TARGET } });
  assert(!r.block, "hatch set: the review gates stay waived for an allowlisted author");
  assert(
    r.calls.every((c) => !FORBIDDEN.some((f) => c.includes(f))),
    `…and no read the review gates need is issued (${r.calls.join(" | ").slice(0, 160)})`,
  );
  assert(
    r.calls.some((c) => c.includes(".pi/merge-authors")),
    "…while the gate file itself IS read, so the author claim rests on a read",
  );
}

teardownLedger();

console.log(`\nexit ${exit}`);
process.exit(exit);
