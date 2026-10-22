#!/usr/bin/env bun
/**
 * #1764 fix round 4 — the MONOTONE invariant, asserted against the frozen base guard.
 *
 * The guard's clause (5) is base's command-wide refusal restored as the DEFAULT, and
 * `review-accept-exempt.ts` is the only thing that may lift it. This suite pins both
 * halves:
 *
 *  - the round-4 corpus (prefix words, assignment ambiguity, shell segments) refuses,
 *    each row by the recorded clause, and its must-stay-allowed neighbours do not move;
 *  - THE PROPERTY: for every row of every corpus table — the fieldbox harvest, the round-3
 *    tables, the #1125 case tables and this round's own — if the FROZEN BASE guard
 *    refuses, the head guard refuses TOO, unless the exemption module positively
 *    understands every segment. Base refusing + head allowing + exemption NOT proven
 *    is the shape of every under-refusal the three review rounds found, and it is the
 *    shape this round makes unrepresentable.
 *
 * The base guard is the byte-frozen copy of the guard at 52a81946 under
 * `accept-guard-base/` — the property runs the REAL base verdicts, not a paraphrase.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commandFullyUnderstood } from "../src/review-accept-exempt.ts";
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import { runsReviewAccept as baseRefuses } from "./accept-guard-base/review-accept-guard.ts";
import {
  ALLOWANCES,
  DENY_BY_DEFAULT_REFUSALS,
  MANDATED_REFUSALS,
  ORDINARY_AGENT_COMMANDS,
  OUT_OF_SCOPE_ALLOWED,
  OVER_REFUSALS,
  SIBLING_REFUSALS,
  SPELLING_REFUSALS,
} from "./review-accept-guard-cases.ts";
import {
  FIELDBOX_RED_TO_GREEN,
  FIELDBOX_STILL_REFUSED_BY_CLAUSE,
} from "./review-accept-guard-fieldbox-cases.ts";
import {
  FIELDBOX_ALREADY_ALLOWED_AT_BASE,
  FIELDBOX_KEEP_REFUSED,
} from "./review-accept-guard-fieldbox-refusals.ts";
import {
  ROUND3_ASSIGNMENTS,
  ROUND3_OPTION_VALUES,
  ROUND3_REDIRECTIONS,
  ROUND3_STILL_ALLOWED,
} from "./review-accept-guard-round3-cases.ts";
import {
  ROUND4_ASSIGNMENTS,
  ROUND4_PREFIX,
  ROUND4_SHELLS,
  ROUND4_STILL_ALLOWED,
} from "./review-accept-guard-round4-cases.ts";
import {
  ROUND5_ACCEPTED_COSTS,
  ROUND5_ASSIGNED_ARG,
  ROUND5_KEEP_ALLOWED,
  ROUND5_OPERATORS,
  ROUND5_PATTERN_FLAG_VALUE,
  ROUND5_QUOTES,
  ROUND5_WHICH,
} from "./review-accept-guard-round5-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The frozen base refusing is a fact about the base copy; a base crash counts as a
 * refusal (the base guard failed closed on its own throw, and a property may not be
 * satisfied by a base that answered nothing). */
function baseRefused(c: string): boolean {
  try {
    return baseRefuses(c) !== undefined;
  } catch {
    return true;
  }
}

// ── 0. THE FROZEN BASE IS THE FROZEN BASE ────────────────────────────────────────
// Every row of this suite routes through `runsReviewAccept` — the `base refuses ⇒ head
// refuses` property that holds the whole #1764 contract. A corpus that grew while the base
// copy silently changed is a suite proving the current guard equals itself, which was the
// round-2 failure mode. The bytes are pinned by content hash (the same SHA-256 a `git
// hash-object` of the file at 52a81946 yields, computed over the file bytes).
const BASE_AT_52a81946: Readonly<Record<string, string>> = {
  "review-accept-arms.ts": "0d6d92c8a03c0ad02c95dc3bba847d8003d802593c3b96440869809d270bef2e",
  "review-accept-command.ts": "f7e083c3a963faa8b172d5b10be3b63f2e784638457090369074494ef8f04f17",
  "review-accept-guard.ts": "dcc62f600dc82aabe3d65e3ebc5d67917d760c25a10373324e2a7f0ba9187bc3",
  "review-accept-scope.ts": "0f5404289796fc2fef2ef0ad131423c3a4744db045193a19bb330e3311b8c277",
  "review-accept-verb.ts": "ebfaefa4d1ce87257233a5437e27f68843a9fcc66be43e906cba62d60131bf98",
  "secret-patterns.ts": "ad5ef8ac982cdad4a514beb46f5c8218d21748305999740577dfc7b9d9421d35",
  "trace.ts": "6afb53ec80fca7f10915bd78a9f6c928a15fc14736a0f4560c1ad230816dd83f",
};

{
  const dir = new URL("./accept-guard-base/", import.meta.url);
  const hashed = Object.keys(BASE_AT_52a81946)
    .map((name) => {
      const bytes = readFileSync(new URL(name, dir));
      const sum = createHash("sha256").update(bytes).digest("hex");
      return { name, ok: sum === BASE_AT_52a81946[name] };
    })
    .sort((a, b) => Number(a.ok) - Number(b.ok));
  const drifted = hashed.filter((h) => !h.ok).map((h) => h.name);
  assert(
    drifted.length === 0,
    `the frozen base is byte-identical to 52a81946 (${Object.keys(BASE_AT_52a81946).length} files pinned)${
      drifted.length ? ` — DRIFTED: ${drifted.join(", ")}` : ""
    }`,
  );
}

// ── 1. the round-4 corpus ───────────────────────────────────────────────────────
const TABLES = [
  ["prefix word", ROUND4_PREFIX],
  ["assignment", ROUND4_ASSIGNMENTS],
  ["shell segment", ROUND4_SHELLS],
] as const;

assert(
  ROUND4_PREFIX.length === 10,
  `corpus: exactly 10 prefix-word rows (got ${ROUND4_PREFIX.length})`,
);
assert(
  ROUND4_ASSIGNMENTS.length === 4,
  `corpus: exactly 4 assignment rows (got ${ROUND4_ASSIGNMENTS.length})`,
);
assert(ROUND4_SHELLS.length === 2, `corpus: exactly 2 shell rows (got ${ROUND4_SHELLS.length})`);
assert(
  // 10 → 8 in fix round 5: `f=notes.md; cat $f` and `F=.git/notes.txt; cat > $F` moved to
  // the accepted-cost table — the exemption may not read a text it substituted for itself.
  ROUND4_STILL_ALLOWED.length === 8,
  `corpus: exactly 10 must-stay-allowed rows (got ${ROUND4_STILL_ALLOWED.length})`,
);

for (const [label, table] of TABLES) {
  for (const t of table) {
    // A THROW is a failed row reported WITH the row: a corpus loop that dies mid-table drops
    // every row after it silently, and the suite still prints the checks it reached.
    let v: { clause?: string } | undefined;
    try {
      v = reviewAcceptVerdict(t.c);
    } catch (e) {
      assert(
        false,
        `${label} row THREW — ${t.why} [${e instanceof Error ? e.message : String(e)}] :: ${t.c.slice(0, 90)}`,
      );
      continue;
    }
    assert(
      v?.clause === t.clause && baseRefused(t.c),
      `${label} refused by ${t.clause} — ${t.why}${
        v ? ` [got ${v.clause}]` : " [it is ALLOWED]"
      }${baseRefused(t.c) ? "" : " [BASE ALLOWED IT TOO]"}`,
    );
  }
}

for (const t of ROUND4_STILL_ALLOWED) {
  let v: { clause?: string } | undefined;
  try {
    v = reviewAcceptVerdict(t.c);
  } catch (e) {
    assert(
      false,
      `must-stay-allowed row THREW — ${t.why} [${e instanceof Error ? e.message : String(e)}]`,
    );
    continue;
  }
  assert(
    v === undefined,
    `must stay allowed — ${t.why}${v ? ` [refused by clause ${v.clause}]` : ""}`,
  );
  // And not by accident: an allowed row must be one the exemption PROVED.
  assert(commandFullyUnderstood(t.c.toLowerCase()), `exemption proves it — ${t.why}`);
}

// ── 2. THE PROPERTY over every corpus table ─────────────────────────────────────
type Row = { readonly c: string; readonly why: string };
const ALL: ReadonlyArray<readonly Row[]> = [
  ALLOWANCES,
  ORDINARY_AGENT_COMMANDS,
  OUT_OF_SCOPE_ALLOWED,
  MANDATED_REFUSALS,
  DENY_BY_DEFAULT_REFUSALS,
  OVER_REFUSALS,
  SIBLING_REFUSALS,
  SPELLING_REFUSALS,
  FIELDBOX_RED_TO_GREEN,
  FIELDBOX_ALREADY_ALLOWED_AT_BASE,
  FIELDBOX_KEEP_REFUSED,
  FIELDBOX_STILL_REFUSED_BY_CLAUSE,
  ROUND3_REDIRECTIONS,
  ROUND3_OPTION_VALUES,
  ROUND3_ASSIGNMENTS,
  ROUND3_STILL_ALLOWED,
  ROUND4_PREFIX,
  ROUND4_ASSIGNMENTS,
  ROUND4_SHELLS,
  ROUND4_STILL_ALLOWED,
  // Round 5 rides the same property: the operator-expansion family and the accepted costs
  // refuse, and the neighbours that stayed allowed must be exemption-proven.
  ROUND5_OPERATORS,
  ROUND5_QUOTES,
  ROUND5_PATTERN_FLAG_VALUE,
  ROUND5_WHICH,
  ROUND5_ASSIGNED_ARG,
  ROUND5_ACCEPTED_COSTS,
  ROUND5_KEEP_ALLOWED,
];

let rows = 0;
let monotonePass = 0;
let exempted = 0;
let baseRefusedRows = 0;
let baseAllowedRows = 0;
for (const table of ALL) {
  for (const r of table) {
    rows++;
    const b = baseRefused(r.c);
    if (b) baseRefusedRows++;
    else baseAllowedRows++;
    let h: boolean;
    try {
      h = reviewAcceptVerdict(r.c) !== undefined;
    } catch (e) {
      assert(
        false,
        `property row THREW under the head guard — ${r.c.slice(0, 90)} [${e instanceof Error ? e.message : String(e)}]`,
      );
      continue;
    }
    if (!b) {
      monotonePass++; // base allowed: head may allow or refuse more — both are monotone.
      continue;
    }
    if (h) {
      monotonePass++;
      continue;
    }
    // Base refused and head allowed: the ONE admissible reason is a completed
    // exemption proof. An unproven exemption is the round-4 defect class.
    if (commandFullyUnderstood(r.c.toLowerCase())) exempted++;
    else
      assert(
        false,
        `MONOTONICITY VIOLATION — base refused, head allowed, exemption NOT proven: ${r.c.slice(0, 90)}`,
      );
  }
}
assert(rows >= 300, `property: ran every corpus row through base and head (${rows} rows)`);
// Health checks on the property itself: a `base refuses ⇒ head refuses` loop over a corpus
// the base never refuses is a suite proving the current guard equals itself — the round-2
// failure mode. Both sides must be populated for the implication to say anything.
assert(
  baseRefusedRows >= 30,
  `property: the frozen base really refuses corpus rows (${baseRefusedRows} refused, ${baseAllowedRows} allowed)`,
);
assert(
  baseAllowedRows >= 30,
  `property: the corpus also holds commands the base allowed, so "base refused" is a discriminator and not a constant (${baseAllowedRows})`,
);
assert(
  monotonePass + exempted === rows,
  `property: base-refusing rows are head-refused (${monotonePass}) or exemption-proven (${exempted}) — all ${rows}`,
);

console.log(
  `round 4: ${ROUND4_PREFIX.length + ROUND4_ASSIGNMENTS.length + ROUND4_SHELLS.length} under-refusals pinned, ${ROUND4_STILL_ALLOWED.length} neighbours held, ${rows} corpus rows checked against the frozen base (${exempted} exemption-proven)`,
);
process.exit(exit);
