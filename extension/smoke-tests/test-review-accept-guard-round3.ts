#!/usr/bin/env bun
/**
 * #1764 fix round 3 — the under-refusals the second review proved were still open,
 * asserted as a corpus with exact counts.
 *
 * Round 2 narrowed the guard's views of a command (bodies dropped, segments split,
 * assignments resolved, options stepped over). Every narrowing was a claim about what a
 * view could safely leave out, and each of the six findings here was a claim that turned
 * out to be false in one shape. The tables live in
 * `review-accept-guard-round3-cases.ts`; this file asserts them and the two structural
 * invariants the fix rests on:
 *
 *  - the GIT option table cannot have a blind spot (H3): every row of it is read by the
 *    selector audit, so adding a row can only ever ADD a refusal;
 *  - assignment resolution only ever ADDS (H2): the substitution can never remove an
 *    expansion word from the text the unreadable-word test asks.
 */
import {
  GIT_OPTIONS,
  gitVerbIndex,
  type GitOptionSpec,
} from "../src/review-accept-verb.ts";
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import { hasUnresolvedRepoSelector } from "../src/review-accept-selector.ts";
import { shellWords } from "../src/review-accept-command.ts";
import { withSameCommandAssignmentsApplied } from "../src/review-accept-views.ts";
import {
  ROUND3_ASSIGNMENTS,
  ROUND3_OPTION_VALUES,
  ROUND3_REDIRECTIONS,
  ROUND3_STILL_ALLOWED,
} from "./review-accept-guard-round3-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TABLES = [
  ["redirect / heredoc", ROUND3_REDIRECTIONS],
  ["option value", ROUND3_OPTION_VALUES],
  ["assignment", ROUND3_ASSIGNMENTS],
] as const;

// Exact counts, not a floor: a table that silently loses a row has lost the regression it
// was written to pin, and `>= N` cannot see that.
assert(
  ROUND3_REDIRECTIONS.length === 11,
  `corpus: exactly 11 redirect / heredoc rows (got ${ROUND3_REDIRECTIONS.length})`,
);
assert(
  ROUND3_OPTION_VALUES.length === 8,
  `corpus: exactly 8 option-value rows (got ${ROUND3_OPTION_VALUES.length})`,
);
assert(
  ROUND3_ASSIGNMENTS.length === 2,
  `corpus: exactly 2 assignment rows (got ${ROUND3_ASSIGNMENTS.length})`,
);
assert(
  // 10 → 9 in fix round 5: `f=notes.md; cat $f` left for the accepted-cost table — the
  // exemption may not read a text it substituted for itself.
  ROUND3_STILL_ALLOWED.length === 9,
  `corpus: exactly 10 must-stay-allowed rows (got ${ROUND3_STILL_ALLOWED.length})`,
);

for (const [label, table] of TABLES) {
  for (const t of table) {
    const v = reviewAcceptVerdict(t.c);
    assert(
      v?.clause === t.clause,
      `${label} refused by ${t.clause} — ${t.why}${
        v ? ` [got ${v.clause}]` : " [it is ALLOWED]"
      }`,
    );
  }
}

for (const t of ROUND3_STILL_ALLOWED) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v === undefined,
    `must stay allowed — ${t.why}${v ? ` [refused by clause ${v.clause}]` : ""}`,
  );
}

// ── H3: one table, no blind spot ────────────────────────────────────────────────
//
// The defect was two lists agreeing with each other and disagreeing with the audit: the
// verb scan stepped over `--namespace $NS` while the selector audit had no rule for it.
// The invariant is therefore about the TABLE, not about any one option: for every row, the
// audit must see the option, and an unresolved value on it must keep the command in scope.
assert(GIT_OPTIONS.length >= 7, `table: git's pre-verb options are enumerated (${GIT_OPTIONS.length})`);
for (const spec of GIT_OPTIONS) {
  const step = [`git`, spec.name, "value", "log"];
  assert(
    gitVerbIndex(step) === 3,
    `table: the verb scan steps over ${spec.name} and its value (got index ${gitVerbIndex(step)})`,
  );
  const unresolved = shellWords(`git ${spec.name} ${"$"}NS log`);
  assert(
    hasUnresolvedRepoSelector(unresolved),
    `table: an unresolved value on ${spec.name} keeps the command in scope`,
  );
  const verdict = reviewAcceptVerdict(`git ${spec.name} ${"$"}NS status --porcelain`);
  assert(
    verdict !== undefined,
    `table: ${spec.name} with an unresolved value is refused outright`,
  );
}

// A row the table marks clearable must still be refused when its VALUE reaches the store —
// `clearable` is "the audit may read it", never "the arm may skip it".
const clearedButReaching: Array<[string, string]> = [
  ["-C", "/repo/.git"],
  ["-c", "core.fsmonitor=/tmp/p"],
];
for (const [flag, value] of clearedButReaching) {
  assert(
    hasUnresolvedRepoSelector(shellWords(`git ${flag} ${value} log`)),
    `table: a clearable option is still unresolved when its value reaches the store (${flag} ${value})`,
  );
}

// ── H2: resolution only ever ADDS ───────────────────────────────────────────────
//
// `F=a; cat $F; F=b` used to resolve to `cat a` at the point of use: the later rebinding
// was invisible to a one-pass scan, so the command read as one the guard could name.
const resolved = withSameCommandAssignmentsApplied(`F=a; cat ${"$"}F; F=b`);
assert(
  resolved.includes(`${"$"}F`),
  `resolution keeps an ambiguous binding unresolved (got ${JSON.stringify(resolved)})`,
);
assert(
  reviewAcceptVerdict(`F=a; cat ${"$"}F; F=b`) !== undefined,
  "guard: a decoy rebinding does not make the read readable",
);
// The one-directional claim, stated as a property over the round's own rows: a word whose
// variable the command NEVER binds must survive the rewrite verbatim. Substitution may
// replace a name the command bound once, unambiguously (criterion 6); dropping any other
// `$` word is the guard losing the very thing it goes on to ask about.
for (const t of [...ROUND3_REDIRECTIONS, ...ROUND3_OPTION_VALUES, ...ROUND3_ASSIGNMENTS]) {
  const rewritten = withSameCommandAssignmentsApplied(t.c);
  for (const word of t.c.split(/\s+/)) {
    if (!word.includes("$")) continue;
    const name = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(word)?.[1] ?? "";
    if (name === "") continue;
    const bindings = (t.c.match(new RegExp(`(?:^|[\\s;&|])${name}=`, "g")) ?? []).length;
    if (bindings > 0) continue;
    assert(
      rewritten.includes(word),
      `resolution left the unresolved word intact in — ${t.why}`,
    );
  }
}

console.log(
  `round 3: ${ROUND3_REDIRECTIONS.length + ROUND3_OPTION_VALUES.length + ROUND3_ASSIGNMENTS.length} under-refusals pinned, ${ROUND3_STILL_ALLOWED.length} neighbours held, ${GIT_OPTIONS.length} table rows audited`,
);
process.exit(exit);
