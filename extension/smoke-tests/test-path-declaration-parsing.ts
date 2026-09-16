#!/usr/bin/env bun
/**
 * A comma inside a parenthetical is not a list separator.
 *
 * Plans routinely qualify a path: `src/config/data.rs (lines 21-44, function
 * body only)`. `extractListField` split every `paths:` value on every comma,
 * so that became two fragments — `src/config/data.rs (lines 21-44` and
 * `function body only)` — each with an unbalanced paren.
 * `normaliseDeclaredPath` could then strip neither, because its regex needs an
 * intact `(...)` at the end.
 *
 * The damage landed on two gates, in opposite directions, which is why it
 * survived so long:
 *
 *   - `findPathCollisions` compared the mangled strings, found no overlap, and
 *     waved through a fan-out where every workstream edited ONE file. Observed
 *     on nessie #693: a ~40-line single-file fix split into three workstreams
 *     all editing `src/config/data.rs`.
 *   - `verifyConsolidation` then looked for those mangled strings in the
 *     committed diff, never found them, and reported every such workstream
 *     MISSING — even after a correct integration. The cycle halted at
 *     `commit-pr-incomplete-consolidation`. Two of nine measured nessie cycles
 *     died there.
 *
 * The recovery advice printed at that halt was itself wrong twice over: it
 * used `git diff HEAD`, which omits untracked new files (the defect the
 * mechanized path fixed in PR19), and `git apply --index`, which rejects a
 * second workstream touching the same file rather than 3-way merging it. Both
 * recipes — the operator's and the LLM fallback prompt's — now match what the
 * mechanized path actually does.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { splitOutsideParens } from "../src/work-driver-plan-parse.ts";
import { normaliseDeclaredPath } from "../src/work-driver-verify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------- the splitter respects parens

{
  const raw = "src/config/data.rs (lines 21-44, function body only), src/other.rs";
  const parts = splitOutsideParens(raw);
  assert(
    parts.length === 2,
    `canary: a parenthetical comma does not split the item (got ${parts.length}: ${JSON.stringify(parts)})`,
  );
  assert(
    parts[0] === "src/config/data.rs (lines 21-44, function body only)",
    "...the qualified path survives whole",
  );
  assert(parts[1] === "src/other.rs", "...and the real separator still separates");

  // Once whole, the existing normaliser can do its job — that was always the
  // contract, and the splitter is what broke it.
  assert(
    normaliseDeclaredPath(parts[0] ?? "") === "src/config/data.rs",
    `canary: the qualified path normalises to a real path (got ${JSON.stringify(normaliseDeclaredPath(parts[0] ?? ""))})`,
  );
}

{
  // Ordinary cases must be untouched.
  assert(
    splitOutsideParens("a.ts, b.ts, c.ts").join("|") === "a.ts|b.ts|c.ts",
    "a plain comma list splits as before",
  );
  assert(splitOutsideParens("a.ts\nb.ts").join("|") === "a.ts|b.ts", "newlines still separate");
  assert(splitOutsideParens("").length === 0, "an empty value yields nothing");
  assert(splitOutsideParens("  only.ts  ").join("") === "only.ts", "a single item is trimmed");
  // A stray `)` must not put the parser into a state where every later comma
  // is treated as nested, gluing the rest of the line into one item.
  assert(
    splitOutsideParens("a.ts), b.ts, c.ts").length === 3,
    "an unbalanced close paren does not swallow the rest of the list",
  );
  assert(
    splitOutsideParens("x.ts (a (b, c) d), y.ts").length === 2,
    "nested parens are counted, not just matched",
  );
}

// ------------------- both gates now see the same path the developer edits

{
  // The #693 shape: three workstreams, all declaring the same file with
  // different line qualifiers. They must collide at plan time.
  const declared = ["d1", "d2", "d3"].map((_, i) =>
    splitOutsideParens(`src/config/data.rs (lines ${i * 10}-${i * 10 + 9}, partial)`).map(
      normaliseDeclaredPath,
    ),
  );
  const flat = declared.flat();
  assert(
    flat.every((p) => p === "src/config/data.rs"),
    `canary: all three workstreams normalise to the SAME path (got ${JSON.stringify(flat)}) — mangled, they looked distinct and the overlap gate passed them`,
  );
  assert(new Set(flat).size === 1, "...so a collision check cannot miss them");
}

// --------------------------- the recovery recipes match reality

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");
  // #544 — the recovery recipe now lives in the SHARED decision module
  // (work-driver-handoff-recovery.ts), consumed by both surfaces; the md
  // presenter is kept in the list so a presenter that inlines its own
  // copy (bypassing the shared decision) still trips the canary.
  // #744 — the per-cap recipe body was extracted into the caps module
  // (work-driver-handoff-recovery-caps.ts); the staged-diff canary follows
  // the literal where it now lives.
  for (const f of ["work-driver-handoff-recovery.ts", "work-driver-prompts-late.ts"]) {
    const src = read(f);
    assert(
      /git apply --3way --binary/.test(src),
      `canary: ${f} advises --3way --binary — it advised --index, which rejects a second workstream on the same file`,
    );
  }
  assert(
    /diff --cached --binary/.test(read("work-driver-handoff-recovery-caps.ts")),
    "canary: work-driver-handoff-recovery-caps.ts captures the STAGED diff — it used `git diff HEAD`, which silently omits untracked new files",
  );
  // And the driver's own path agrees with what it tells the operator to do.
  assert(
    /git apply --3way --binary/.test(read("work-driver-cherry-pick.ts")),
    "the mechanized path uses the same recipe it documents",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
