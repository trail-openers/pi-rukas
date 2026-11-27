#!/usr/bin/env bun
/**
 * lean #2660 — an arm that forwards a bound must forward its grace beside it.
 *
 * `armBudget` hands a deadline-derived arm out as a PAIR (`lean/step-budget.ts`), and every
 * lean dispatch seam takes the arms key by key rather than spreading them — deliberately,
 * because a spread lets a later operator knob silently re-supply an earlier one. That is
 * exactly the shape in which one half of a pair goes missing: `childBoundMs` forwarded,
 * `childBoundGraceMs` dropped on the floor, the child then armed with the configured 10-minute
 * grace on a bound the deadline placed 8 minutes from the line. It shipped in build, challenge
 * and specify while every step-side suite was green, because each captured the opts at its
 * fixture's seam, upstream of the literal that dropped the key.
 *
 * So this is the enumeration half: not another assertion about one step, but a scan that
 * refuses the CLASS. For every place in `src/lean/` that re-forwards a bound off an armed
 * source (`childBoundMs: <expr>.childBoundMs` — a key-by-key re-forward, not a derivation),
 * the same dispatch options must name `childBoundGraceMs` beside it. Derivations and clamps
 * (`Math.min(budgetBoundMs ?? …)`, `FIX_BOUND_MS`, a bare `boundMs`) construct a value rather
 * than re-forwarding one and are not policed here; those sites are pinned at their leaves by
 * `test-lean-step-deadline-bound-sites.ts` and `test-lean-review-deps-grace.ts`.
 *
 * The scan is exact about what it matches and prints `file:line` for every miss, so a failure
 * names the literal to fix rather than the file to read.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const SRC_LEAN = path.resolve(import.meta.dirname, "..", "src", "lean");

/** A key-by-key re-forward of the bound, in either shape lean's seams use: the plain
 *  `childBoundMs: o.childBoundMs`, or the guarded `… ? {} : { childBoundMs: o.childBoundMs }`.
 *  A clamp (`Math.min(budgetBoundMs ?? …)`), a constant (`FIX_BOUND_MS`) or a bare local
 *  (`boundMs`) is not a re-forward and does not match. */
const FORWARD = /childBoundMs:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.childBoundMs\b/g;

/** The grace key, named as a key (`childBoundGraceMs:`) rather than mentioned in prose. */
const GRACE = /\bchildBoundGraceMs\s*:/g;

/** How far from a bound the grace may sit and still count as "beside it". Covers both the
 *  plain two-line pair and the guarded spread placed next to its bound, and refuses a grace
 *  parked in another function of the same file. A window rather than brace-nesting because the
 *  guarded-spread shape puts the bound inside a ternary's object and the grace in a sibling
 *  one: the two are never inside a single enclosing literal, so a nesting rule would fail on
 *  correct code. */
const NEAR_CHARS = 400;

function leanFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) leanFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** True when the match begins on a comment line — documentation of a forward is not one. */
function onComment(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  return /^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, at));
}

const files = leanFiles(SRC_LEAN).sort();
assert(files.length > 100, `(pre) the scan read the lean tree (${String(files.length)} files)`);

const misses: string[] = [];
let forwards = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = path.relative(path.resolve(SRC_LEAN, ".."), file);
  const graceAt = [...text.matchAll(GRACE)]
    .filter((m) => !onComment(text, m.index ?? 0))
    .map((m) => m.index ?? 0);
  for (const m of [...text.matchAll(FORWARD)]) {
    const at = m.index ?? 0;
    if (onComment(text, at)) continue;
    forwards++;
    const line = text.slice(0, at).split("\n").length;
    // The grace must be named, and named beside THIS bound — anywhere else in the file is a
    // different child's dispatch options and proves nothing about these.
    const beside = graceAt.some((g) => Math.abs(g - at) <= NEAR_CHARS);
    if (!beside)
      misses.push(
        `${rel}:${String(line)} — childBoundMs forwarded with no childBoundGraceMs within ${String(
          NEAR_CHARS,
        )} chars, so the child gets the configured grace and its kill lands a full grace past where the deadline put the bound`,
      );
  }
}

assert(
  forwards >= 4,
  `(pre) the scan found the bound forwards it exists to police (${String(forwards)}; build, challenge, specify's seam and the review fixer's are four)`,
);
assert(
  misses.length === 0,
  `every lean bound forward is paired with its grace — ${String(misses.length)} missing:\n${misses.join("\n")}`,
);

process.exit(failures() === 0 ? 0 : 1);
