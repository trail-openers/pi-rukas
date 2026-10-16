#!/usr/bin/env bun
/**
 * #962 — the merge guard accepts only a plain merge command
 * (merge-allowlist.ts). Every accepted form with its number and repo; every
 * bypass shape from the #955/#1317 reviews refused; ordinary non-merge
 * commands allowed; the refusal driven through the real hook; a 30 kB
 * command analysed well inside the hook budget; the forge-detect git bound.
 *
 * The command tables the loops below assert over are data with no behaviour,
 * so they live in `lib/merge-allowlist-fixtures.ts` (the §12 size cap); the
 * 30 kB perf shapes in `lib/merge-allowlist-harness.ts`, and the stalled-`git`
 * bound in `lib/merge-allowlist-target.ts`. Every assertion stays here, in the
 * file that owns the decision it pins.
 */

import { readFileSync } from "node:fs";
import type { MergeCommand } from "../src/merge-allowlist.ts";
import { readMergeCommand } from "../src/merge-allowlist.ts";
import { analyseRefusal } from "../src/merge-guard.ts";
import { mergeFormRefusal } from "../src/merge-refusals.ts";
import {
  ACCEPTED,
  CODES,
  GLAB_NO_OPT_OUT,
  NOT_MERGES,
  REFUSED,
  RESIDUAL,
} from "./lib/merge-allowlist-fixtures.ts";
import { assertBigCommandsInsideBudget } from "./lib/merge-allowlist-harness.ts";
import { assertStalledGitIsBounded } from "./lib/merge-allowlist-target.ts";
import {
  assert,
  GOOD_ENTRIES,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const show = (m: MergeCommand) => JSON.stringify(m);

// ------------------------------------------------------------ accepted forms
for (const [cmd, forge, n, repo] of ACCEPTED) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "merge" && m.forge === forge && m.prNumber === n && m.repo === repo,
    `accepted: ${JSON.stringify(cmd)} → ${forge} #${n ?? "branch"} ${repo ?? ""} (${show(m)})`,
  );
}

// ------------------------------------------------------------ refused shapes
for (const cmd of REFUSED) {
  const m = readMergeCommand(cmd);
  assert(m.kind === "refused", `refused: ${JSON.stringify(cmd)} (${show(m)})`);
}
// A glab merge missing the opt-out gets its own refusal, naming the accepted form.
for (const cmd of GLAB_NO_OPT_OUT) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && m.reason === "glab-auto-merge",
    `glab opt-out refusal: ${JSON.stringify(cmd)} (${show(m)})`,
  );
}
assert(readMergeCommand("gh pr merge 17").kind === "merge", "gh merge needs no opt-out");
const apiMerge = readMergeCommand("gh api repos/o/r/pulls/1/merge");
assert(
  apiMerge.kind === "refused" && apiMerge.reason !== "glab-auto-merge",
  "other refusals keep the generic form",
);

// ------------------------------------------------------------ reason codes
for (const [cmd, code] of CODES) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && (m.reason ?? "").startsWith(code),
    `reason ${code}: ${JSON.stringify(cmd)} (${show(m)})`,
  );
}
assert(
  mergeFormRefusal("x").includes("pr merge [N]") && mergeFormRefusal("x").includes("[reason: x —"),
  "the form refusal keeps the accepted form and names the reason with its explanation",
);

// ------------------------------------------------------------ granted merges
// Every merge-shaped bash grant in agents.json must be a command the guard
// accepts; a grant it refuses (e.g. `oo gh pr merge*`) can never be used.
{
  const agents = JSON.parse(
    readFileSync(new URL("../../agents.json", import.meta.url), "utf8"),
  ) as {
    agent: Record<string, { permission?: { bash?: Record<string, string> } }>;
  };
  let checked = 0;
  for (const [role, cfg] of Object.entries(agents.agent)) {
    for (const [key, verdict] of Object.entries(cfg.permission?.bash ?? {})) {
      if (verdict !== "allow") continue;
      const m = readMergeCommand(key.replace(/\*+$/, "").trimEnd());
      if (m.kind === "none") continue;
      checked += 1;
      assert(
        m.kind === "merge",
        `agents.json ${role} grants a merge the guard refuses: ${JSON.stringify(key)} (${show(m)})`,
      );
    }
  }
  assert(
    checked >= 1,
    `agents.json grants at least one merge the guard accepts (${checked} checked)`,
  );
  console.log(`merge-shaped grants in agents.json checked: ${checked}`);
}

// ------------------------------------------------------------ not merges
for (const cmd of NOT_MERGES) {
  const m = readMergeCommand(cmd);
  assert(m.kind === "none", `not a merge: ${JSON.stringify(cmd)} (${show(m)})`);
}

// ------------------------------------------------------------ the residual
for (const cmd of RESIDUAL) {
  assert(
    readMergeCommand(cmd).kind === "none",
    `documented residual (not read as a merge): ${cmd}`,
  );
}

// ------------------------------------------------------------ the real hook
await setupLedgerPath();
for (const cmd of ["cd x && gh pr merge 17", "gh api repos/o/r/pulls/12/merge"]) {
  const r = await hookDecision(cmd, GOOD_ENTRIES);
  assert(r.block, `hook refuses even with a passing ledger: ${JSON.stringify(cmd)}`);
  assert(r.calls.length === 0, `…before any forge call: ${JSON.stringify(cmd)}`);
  const reason = r.reason ?? "";
  // #1417 — the two halves split. The guard's own hold (`command held`) never
  // names the merge escape hatch. A refusal that still reads as the guard's
  // form refusal ("merge refused") — a command the grammar accepted as a
  // merge attempt — does, because there the merge is genuinely at stake.
  const hatch = /^command held/.test(reason)
    ? !reason.includes("PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1")
    : reason.includes("PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1");
  assert(
    reason.includes("pr merge [N]") && hatch,
    "…naming the accepted form, and the hatch only for a real merge",
  );
  // `--body-file` / `git commit -F` are the guidance for a command that puts
  // PROSE in the command line; a held command whose body was indirect needs
  // them, and one that merely chains commands does not — so they are pinned
  // where they belong rather than in every refusal.
  assert(
    !reason.includes("command held") || reason.includes("the guard does check is"),
    "…and a hold always names the shape the guard checks",
  );
}
{
  const r = await hookDecision("gh pr merge 12 -R o/r", GOOD_ENTRIES);
  assert(!r.block, "hook allows an accepted form with a passing ledger");
  assert(
    r.calls.some((c) => c.startsWith("gh pr view 12 ") && c.endsWith("-R o/r")),
    "…reading the PR the command names, in the repo it names",
  );
}
{
  const r = await hookDecision("gh pr merge --squash", GOOD_ENTRIES);
  assert(!r.block, "hook resolves a number-less merge from the current branch");
  assert(
    r.calls.some((c) => c.includes("--json number")),
    "…via gh pr view --json number",
  );
}
{
  // The PR read follows the repo's forge (github here); a glab merge would act
  // on a GitLab MR the guard never read.
  const r = await hookDecision("glab mr merge 12 --auto-merge=false", GOOD_ENTRIES);
  assert(
    r.block && /merges on gitlab but this repo's forge is github/.test(r.reason ?? ""),
    "hook refuses a merge aimed at the other forge",
  );
}
{
  const r = await hookDecision("glab mr merge 12", GOOD_ENTRIES);
  assert(
    r.block && /without `--auto-merge=false`/.test(r.reason ?? "") && r.calls.length === 0,
    "hook refuses a bare glab merge with the accepted form named",
  );
}
{
  // Fail closed: a reader that throws (here on a non-string command) refuses.
  const r = await hookDecision({} as never, GOOD_ENTRIES);
  assert(
    r.block && /command held \(not a merge\)/.test(r.reason ?? ""),
    "hook refuses when the reader throws",
  );
  assert(
    !(r.reason ?? "").includes("PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE"),
    "…and does not offer the merge hatch for a command it could not analyse",
  );
  assert(
    /classifier threw/.test(r.reason ?? ""),
    "…naming the classifier as what failed, not the reviews",
  );
}
for (const cmd of ["gh pr view 17 --json mergeable", "git merge --ff-only origin/main"]) {
  const r = await hookDecision(cmd, []);
  assert(!r.block && r.calls.length === 0, `hook allows a non-merge untouched: ${cmd}`);
}
teardownLedger();

// ------------------------------------------------------------ fail closed
assert(analyseRefusal(null) === "null", "analyseRefusal renders a thrown null without throwing");
assert(analyseRefusal(new RangeError("deep")) === "RangeError: deep", "…and an Error by name");

// ------------------------------------------------------------ performance
assertBigCommandsInsideBudget();

// ------------------------------------------------------------ forge-detect git bound
await assertStalledGitIsBounded();

console.log(`\nexit ${exit}`);
process.exit(exit);
