#!/usr/bin/env bun
/**
 * #952 — the code-review-specialist token budget ships with a MEASURED
 * default (8 000 000 tokens), and the kill attribution names a SETTABLE env
 * key: a hyphenated role name (code-review-specialist) must map to underscores
 * (CODE_REVIEW_SPECIALIST), not the literal hyphenated (unsettable) name.
 *
 * These assertions moved from test-dispatch-caps.ts (the #952 additions to
 * that file's section 1 block and its section 1b block); see that file's
 * header for the #543 F6 context they live alongside.
 */

import { tokenBudgetEnvKey, tokenBudgetFor } from "../src/spawn-support.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    assert(true, msg);
  } else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// 1. #952 (before/after): before #952 the corresponding assertion in
// test-dispatch-caps.ts asserted
// `tokenBudgetFor("code-review-specialist") === 0` — every role shipped
// default-OFF. Now code-review-specialist ships with a measured default
// (8 000 000 tokens, from ~1 073 lens children, p95 = 4 104 877, 2× p95
// rounded, transcripts 2026-09-27…2026-10-01). All other roles remain 0.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: undefined,
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 8_000_000,
  ),
  "tokenBudgetFor: unset → 8 000 000 (measured default) for code-review-specialist",
);
// Env override wins over the default.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: "2000000",
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 2_000_000,
  ),
  "tokenBudgetFor: env override wins over the code-review-specialist default",
);
// Env "0" explicitly disables the default.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: "0",
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 0,
  ),
  "tokenBudgetFor: env 0 disables the code-review-specialist default",
);
// Non-numeric env → 0 (off), never NaN.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: "not-a-number",
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 0,
  ),
  "tokenBudgetFor: non-numeric env → 0 for code-review-specialist",
);

// 1b. #952 — the kill attribution names a SETTABLE env key: a hyphenated
// role name (code-review-specialist) must map to underscores
// (CODE_REVIEW_SPECIALIST), not the literal hyphenated (unsettable) name.
eq(
  tokenBudgetEnvKey("code-review-specialist"),
  "PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST",
  "tokenBudgetEnvKey: code-review-specialist → underscored env key",
);
eq(
  tokenBudgetEnvKey("developer"),
  "PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER",
  "tokenBudgetEnvKey: developer → unchanged",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
