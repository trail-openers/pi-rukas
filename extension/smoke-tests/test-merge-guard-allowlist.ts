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
import { FORGE_WORD } from "../src/merge-lex-views.ts";
import { mergeFormRefusal } from "../src/merge-refusals.ts";
import {
  ACCEPTED,
  CODES,
  EXPANSION_CANARIES,
  GLAB_NO_OPT_OUT,
  NOT_MERGES,
  REFUSED,
  RESIDUAL,
  longMergeCommand,
  longReadCommands,
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

// #1417 round 2 — the size bound's forge test is the TRIGGER'S word set, not a
// narrower one. Everything the grammar can read as a merge contains a word
// `FORGE_WORD` matches (the grammar's command word is `gh` or `glab`, both in
// that set), so no accepted merge can ever be exempted from the bound by
// length alone. Were this ever false, a long enough real merge command would
// skip the bound and fall through to current-branch PR resolution — the #955
// failure mode, arriving through the read side.
for (const [cmd] of ACCEPTED) {
  assert(
    FORGE_WORD.test(cmd),
    `every accepted merge form names a forge word, so the bound can always see it: ${JSON.stringify(cmd)}`,
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
// #1417 LOW — `reason` is the BARE code, compared EXACTLY (it used to carry
// its clause inline, so nothing could compare it); `detail` carries the prose
// and is asserted to be present where the rule is not self-evident.
for (const [cmd, code, detail] of CODES as Array<[string, string, string?]>) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && m.reason === code,
    `reason ${code}: ${JSON.stringify(cmd.slice(0, 60))} (${show(m).slice(0, 160)})`,
  );
  if (detail !== undefined) {
    assert(
      m.kind === "refused" && (m.detail ?? "").includes(detail),
      `detail for ${code}: ${JSON.stringify(cmd.slice(0, 60))} (${show(m).slice(0, 160)})`,
    );
  }
}
// The code never carries its clause any more — that is the whole point of the
// split, and a regression here silently breaks every exact-match consumer.
for (const [cmd, code] of CODES) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "refused" && !/\s—\s/.test(m.reason ?? ""),
    `reason is a bare code, never code + prose: ${JSON.stringify(cmd.slice(0, 40))} (${show(m).slice(0, 120)})`,
  );
  assert(code === code.trim(), `code has no padding: ${code}`);
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

// ------------------------------------------------------------ #1317 expansion canaries
// The shapes the deleted `test-merge-guard-1317.ts` gated, each with the
// verdict the allowlist produces now. A `"none"` row is an explicitly named
// INERT residual (the merge word never appears, so nothing triggers) — a
// reviewed decision, not a silent deletion; the RESIDUAL table below is the
// rest of that list.
for (const [cmd, kind, code] of EXPANSION_CANARIES) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === kind,
    `#1317 canary → ${kind}: ${JSON.stringify(cmd.slice(0, 60))} (${show(m).slice(0, 160)})`,
  );
  if (code !== undefined) {
    assert(
      m.kind === "refused" && m.reason === code,
      `#1317 canary reason ${code}: ${JSON.stringify(cmd.slice(0, 60))} (${show(m).slice(0, 160)})`,
    );
  }
}

// ------------------------------------------------------------ the size bound, both sides
// The bound (#955, restored by #1417) holds a merge-bearing command too long
// to read — and holds nothing else. Both halves are asserted, because the
// #1417 symptom is the second half failing: a long READ refused for its length
// is the same class of failure as the reads in the original reports, and a
// bound that over-refuses gets quietly worked around by operators instead of
// fixed. `longMergeCommand` is one command that must be held.
{
  const m = readMergeCommand(longMergeCommand());
  assert(
    m.kind === "refused" && m.reason === "too-large",
    `bound holds a long merge: ${JSON.stringify(m).slice(0, 90)}`,
  );
}
// …and `longReadCommands` are commands that must not be.
for (const cmd of longReadCommands()) {
  const m = readMergeCommand(cmd);
  assert(
    m.kind === "none",
    `bound leaves a long read alone (length is not a hold): ${JSON.stringify(cmd.slice(0, 50))}… (${JSON.stringify(m).slice(0, 90)})`,
  );
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
// #1417 — the reads the reports named, driven through the HOOK and not just
// the classifier. A read that classifies `none` but blocks at the hook is the
// failure the operator actually saw, and the length axis is where the first
// cut of the size bound reproduced it. Zero exec calls is part of the claim:
// a blocked read means nothing ran at all.
for (const cmd of longReadCommands()) {
  const r = await hookDecision(cmd, []);
  assert(
    !r.block && r.calls.length === 0,
    `hook runs a long read untouched: ${JSON.stringify(cmd.slice(0, 50))}… (${(r.reason ?? "").slice(0, 80)})`,
  );
}
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
  // #1417 round 2 — the hold's TRACE CODE is the cause that actually fired.
  // `earlyRefuse` used to hardcode `unresolved-pr-number` for every step
  // before the target read, and the `refused` branch passed the bare reason
  // code through; a matrix that read only block/reason could not tell the two
  // apart, so a mislabelled cause stayed invisible in exactly the log a false
  // hold gets reported from. Three causes, three codes, asserted at the seam.
  const longMerge = `gh pr merge 17 ${"y".repeat(9000)}`;
  for (const [cmd, code] of [
    // Classifier refusal: the grammar stopped at an unknown flag.
    ["gh pr merge 17 --auto", "unknown-flag"],
    // The size bound: too long to read, so nothing was analysed.
    [longMerge, "too-large"],
  ] as Array<[string, string]>) {
    const r = await hookDecision(cmd, GOOD_ENTRIES);
    assert(
      // Anchored on the `reason=` FIELD the trace line emits: `reason=<code>`
      // followed by a SPACE (the line is `reason=<code> commandLength=<n>`).
      // Deliberately not `includes(code)` and not `\b`: the trace line carries
      // codes that themselves contain `-`, and `\b` after a trailing `-`
      // matches the colon of a code-plus-detail spelling (`unknown-flag` would
      // match inside `unknown-flag:--auto`), so a prefix match silently passes
      // a mislabelled cause — the exact failure mode this block exists to catch.
      // (`\\s`, not `\s`: inside a template literal the pattern is a string and
      // needs the doubled backslash to reach the regex as `\s`.)
      r.block &&
        r.traces.length === 1 &&
        new RegExp(`reason=${code}(?=\\s)`).test(r.traces[0] ?? ""),
      `hold logs ${code}: ${cmd.slice(0, 30)}… (${JSON.stringify(r.traces)})`,
    );
    // The secret-leak invariant from the earlier round: the hold line carries
    // the code and the LENGTH only, never the command text — which is also why
    // the assertion above cannot be satisfied by the command echoing back.
    assert(
      !r.traces.some((h) => h.includes("--auto") || h.includes("yyyy")),
      `…and the hold line repeats no part of the command text: ${cmd.slice(0, 30)}…`,
    );
  }
  {
    // The one early step that is reachable today: no number in the command and
    // the branch resolves to no PR. Before #1417 round 2 this was the ONLY
    // cause `earlyRefuse` could ever report, whatever had actually failed.
    const r = await hookDecision("gh pr merge", GOOD_ENTRIES, { branchNumber: "empty" });
    assert(
      r.block && r.traces.length === 1 && /reason=unresolved-pr-number(?=\s)/.test(r.traces[0] ?? ""),
      "early refusal logs the cause that fired (unresolved-pr-number)",
    );
    assert(
      !r.traces.some((h) => /reason=(form|not-a-merge|unknown-flag|too-large)\b/.test(h)),
      "…and never another seam's code for a resolution failure",
    );
  }
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
