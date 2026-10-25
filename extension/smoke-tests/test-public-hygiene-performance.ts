#!/usr/bin/env bun
/**
 * public-hygiene performance (#1792 final round) — the text rules the guard runs
 * on EVERY publish surface of EVERY agent turn must stay linear in the input,
 * because a rule that is quadratic on an adversarial-looking body is a
 * denial-of-service on the session that publishes it.
 *
 * ## What is actually measured, and what is not
 *
 * The one shape this file pins is the one the brief names: a long run of
 * non-delimiter characters, no `@`, no `/`, classified through
 * {@link genericCategoryOf} in under {@link CLASSIFY_BUDGET_MS}.
 *
 * The claim behind {@link HOME_PATH}'s bound — that the unbounded `\w+` was
 * catastrophically slow — did **not** reproduce on this engine at any length up
 * to 200,000 characters (the `HOME_PATH_BOUND` note in `public-denylist.ts`
 * carries the measurement). That is not a reason to skip the bound: an engine
 * that memoises a failed `\w+` today is not a contract for tomorrow, and
 * `{1,255}` costs nothing. But a test that asserted a speed-up the code does not
 * produce would be a test of a story rather than of the code, so this file
 * measures the bound's real consequences instead — the input is classified inside
 * the budget, and every realistic path still matches.
 *
 * Terms are synthetic — this repository is public.
 */

import { genericCategoryOf } from "../src/public-denylist.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** The budget the brief sets for classifying a 200,000-character run. */
const CLASSIFY_BUDGET_MS = 500;

/** 200,000 non-delimiter characters: no `@`, no `/`, no word boundary the rules
 * could latch onto. The shape is the one a pathological body is made of. */
const RUN_LENGTH = 200_000;

// ── 1. The bound's headline: a 200,000-character run is classified in the budget.
{
  const text = "x".repeat(RUN_LENGTH);
  const started = Date.now();
  const category = genericCategoryOf(text);
  const elapsed = Date.now() - started;
  assert(
    elapsed < CLASSIFY_BUDGET_MS,
    `a ${RUN_LENGTH}-character non-delimiter run classifies in under ${CLASSIFY_BUDGET_MS} ms (took ${elapsed} ms)`,
  );
  assert(category === undefined, "and a run of nothing but characters is not a finding");
}

// ── 1b. The same run in the shapes that put the regex's leading class and the
// email blanking under the most work — each still inside the budget, so the
// bound is not bought at the cost of a slower neighbour.
{
  const shapes: readonly [string, string][] = [
    ["word run then @", `${"x".repeat(RUN_LENGTH)}@`],
    ["@ then word run", `@${"x".repeat(RUN_LENGTH)}`],
    ["non-word then run then @", `!${"x".repeat(RUN_LENGTH)}@`],
    ["run then a clean home path", `${"x".repeat(RUN_LENGTH)} /home/alice`],
    ["many candidate starts", `!${`/home/${"x".repeat(20)}`.repeat(RUN_LENGTH / 22)}`],
  ];
  for (const [label, text] of shapes) {
    const started = Date.now();
    genericCategoryOf(text);
    const elapsed = Date.now() - started;
    assert(
      elapsed < CLASSIFY_BUDGET_MS,
      `the ${label} shape classifies in under ${CLASSIFY_BUDGET_MS} ms (took ${elapsed} ms)`,
    );
  }
}

// ── 2. The bound changed which strings count only above what a username can be.
// Every realistic path the unbounded rule matched still matches — that is the
// "without changing which strings match on realistic input" half of the change,
// and it is what a reviewer cannot tell from reading the quantifier alone.
{
  for (const text of [
    "/home/alice/secrets",
    "/Users/alice/x",
    "x /home/alice/",
    "contact ops@example.invalid, logs in /home/alice/x",
    "mail ops@example.invalid or read /Users/alice/notes",
    "/home/a",
    "/Users/bob",
  ]) {
    assert(
      genericCategoryOf(text) === "home-path",
      `a realistic home path is still a finding: ${text.slice(0, 32)}`,
    );
  }
  for (const text of ["/home/dev/x", "/home/user/x", "/home/example/x", "/home/ops/x", "/home/runner/x"]) {
    assert(genericCategoryOf(text) !== "home-path", `the placeholder name still passes: ${text}`);
  }
  // A 255-character name — the longest a POSIX username or a macOS home
  // directory name can be — is inside the bound and is still a finding, so the
  // documented accepted limit sits above every real input rather than inside it.
  assert(
    genericCategoryOf(`/home/${"a".repeat(255)}`) === "home-path",
    "the longest real username is still matched by the bounded quantifier",
  );
}

// ── 3. A pathological input still cannot make the guard report a finding it has
// no evidence for: the run is clean, and a real path inside it is still found.
{
  const buried = `${"x".repeat(50_000)} /home/alice/secret-notes`;
  const started = Date.now();
  const category = genericCategoryOf(buried);
  const elapsed = Date.now() - started;
  assert(category === "home-path", "a home path buried after 50,000 characters is still found");
  assert(
    elapsed < CLASSIFY_BUDGET_MS,
    `and finding it costs under ${CLASSIFY_BUDGET_MS} ms (took ${elapsed} ms)`,
  );
}

process.exit(exit);
