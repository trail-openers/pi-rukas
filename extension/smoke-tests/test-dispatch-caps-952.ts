#!/usr/bin/env bun
/**
 * #952 / #1642 — the token-budget env key for a hyphenated role name
 * (code-review-specialist) must map to underscores (CODE_REVIEW_SPECIALIST),
 * not the literal hyphenated (unsettable) name, and an explicit env value is
 * what arms a budget: #952 gave code-review-specialist a MEASURED default of
 * 8 000 000 tokens, and the operator decision of 2026-10-20 removed it — every
 * role now ships default-OFF, with `PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>` as the
 * only way to arm a ceiling (see spawn-token-budget.ts for why).
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

// 1. #952 added, #1642 removed: the code-review-specialist measured default.
// Before #952 every role shipped default-OFF; #952 armed 8 000 000 tokens for
// the lens role alone (p95 = 4 104 877 over ~1 073 lens children, 2× p95
// rounded); #1642 reverted it because the number is model- and
// repo-size-dependent and a killed lens forces a full re-review. So unset
// means OFF for every role, and the ONLY way a lens gets a ceiling is an
// explicit env value.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: undefined,
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 0,
  ),
  "tokenBudgetFor: unset → 0 (off) for code-review-specialist (#1642 — no built-in budget)",
);
// An explicit env value arms the ceiling for the lens role — the opt-in path.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: "2000000",
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 2_000_000,
  ),
  "tokenBudgetFor: explicit env value arms a ceiling for code-review-specialist",
);
// Explicit "0" is off — same answer as unset.
assert(
  withEnv(
    {
      PI_ENSEMBLE_TOKEN_BUDGET_CODE_REVIEW_SPECIALIST: "0",
      PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
    },
    () => tokenBudgetFor("code-review-specialist") === 0,
  ),
  "tokenBudgetFor: env 0 is off for code-review-specialist",
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
