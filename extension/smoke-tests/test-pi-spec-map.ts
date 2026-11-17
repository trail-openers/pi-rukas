#!/usr/bin/env bun
/**
 * pi-spec-map — the shared bullets→`PiSpec` mapping.
 *
 * `/plan` and `work-lean`'s spec-intake both map plain-language bullets onto the
 * contract, and the point of the shared leaf is that they cannot disagree. So
 * this file pins the BOUNDS the mapper enforces (they are what `plan-pi-spec.ts`
 * reserves its budget against and what `readiness` later judges), and pins that
 * `lean/` can reach the mapper without reaching `/plan`.
 *
 * The round-trip case is the load-bearing one: `work-lean` validates a derived
 * spec by `parsePiSpec(renderPiSpec(spec))` deep-equaling the spec, so a mapping
 * whose output the parser cannot read back is a contract no run can execute.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parsePiSpec, readiness, renderPiSpec } from "../src/lean/spec.ts";
import {
  CRITERION_MAX_CHARS,
  MAX_CRITERIA,
  PROBLEM_MAX_CHARS,
  clip,
  criterionText,
  mappingDisagrees,
  neutraliseFenceRuns,
  oneLine,
  piSpecFromBullets,
  problemText,
  sizeOf,
} from "../src/pi-spec-map.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    failed = 1;
  }
}

// ── The mapping's shape.
{
  const spec = piSpecFromBullets("the retry helper gives up too early", [
    "retries a transient failure twice",
    "gives up after the configured ceiling",
    "names the ceiling in the error",
    "a fourth bullet that sizes it M",
  ]);
  assert(spec !== undefined, "a problem and bullets yield a spec");
  assert(
    spec?.criteria.map((c) => c.id).join(",") === "AC1,AC2,AC3,AC4",
    `ids are positional AC1… (got ${JSON.stringify(spec?.criteria.map((c) => c.id))})`,
  );
  assert(
    spec?.criteria.every((c) => c.verify === "test") === true,
    "every criterion is verify: test",
  );
  assert(
    spec?.criteria.every((c) => c.command === undefined) === true,
    "no criterion carries a command — neither producer may make one executable",
  );
  assert(spec?.scope === undefined, `no scope is invented (got ${JSON.stringify(spec?.scope)})`);
  assert(spec?.size === "M", `four criteria size M (got ${String(spec?.size)})`);
}

// ── Nothing to contract is undefined, never an empty block.
for (const [problem, bullets, label] of [
  ["", ["a bullet"], "no statement"],
  ["   ", ["a bullet"], "a blank statement"],
  ["a problem", [], "no bullets"],
] as const) {
  assert(
    piSpecFromBullets(problem, bullets) === undefined,
    `${label}: undefined, so no empty contract is ever filed`,
  );
}

// ── The bounds.
{
  const long = "x".repeat(500);
  assert(
    criterionText(long).length <= CRITERION_MAX_CHARS,
    `a criterion never exceeds ${CRITERION_MAX_CHARS} (got ${criterionText(long).length})`,
  );
  assert(
    problemText(long).length <= PROBLEM_MAX_CHARS,
    `the problem never exceeds ${PROBLEM_MAX_CHARS} (got ${problemText(long).length})`,
  );
  const many = piSpecFromBullets(
    "p",
    Array.from({ length: 40 }, (_, i) => `b${String(i)}`),
  );
  assert(
    many?.criteria.length === MAX_CRITERIA,
    `at most ${MAX_CRITERIA} criteria embed (got ${String(many?.criteria.length)})`,
  );
  assert(many?.size === "L", `size counts the ORIGINAL 40, so L (got ${String(many?.size)})`);
  assert(
    sizeOf(3) === "S" && sizeOf(4) === "M" && sizeOf(8) === "M" && sizeOf(9) === "L",
    "the band boundaries are 3 and 8",
  );
}

// ── Whitespace and control characters collapse to one line.
{
  const spec = piSpecFromBullets("a\n problem\twith\nruns", ["  a\n  bullet\twith\vruns  "]);
  assert(
    spec?.problem === "a problem with runs",
    `the problem collapses to one line (got ${JSON.stringify(spec?.problem)})`,
  );
  assert(
    spec?.criteria[0]?.text === "a bullet with runs",
    `a bullet collapses to one line (got ${JSON.stringify(spec?.criteria[0]?.text)})`,
  );
}

// ── Fence runs are disarmed BEFORE the clip, and the block still reads back.
{
  const fenced = "run ```bun test``` and it exits 0";
  const neutralised = neutraliseFenceRuns(fenced);
  assert(
    neutralised.length === fenced.length,
    `neutralising is 1:1 in width (got ${neutralised.length} for ${fenced.length})`,
  );
  assert(neutralised.includes("```") === false, "a 3-run cannot survive neutralisation");
  assert(!/`/.test(neutraliseFenceRuns("~~~")), "a tilde run is disarmed too");
  assert(
    neutraliseFenceRuns("run `bun test` here") === "run `bun test` here",
    "a single backtick is left alone — it cannot fence anything",
  );
  const spec = piSpecFromBullets("the `problem` with ~~~~ fences", [
    fenced,
    "a tilde run ```` inside ~~~~ a bullet",
    "a path `extension/src/lean/spec.ts` is quoted",
  ]);
  if (spec === undefined) {
    assert(false, "a fence-bearing reply yields a spec");
  } else {
    const rendered = renderPiSpec(spec);
    const back = parsePiSpec(rendered);
    assert(
      back.ok && JSON.stringify(back.spec) === JSON.stringify(spec),
      `parsePiSpec(renderPiSpec(spec)) deep-equals the spec even with backtick runs (got ${back.ok ? "a different spec" : back.reason})`,
    );
    assert(
      readiness(spec).length === 0,
      `…and readiness passes it (got ${JSON.stringify(readiness(spec))})`,
    );
    // A clip that landed mid-stand-in would leave a real backtick at the tail;
    // the width-preserving order is what makes that impossible.
    for (const c of spec.criteria) {
      assert(
        !c.text.endsWith("`") || !c.text.endsWith("```"),
        `criterion text does not end in a live fence run (${JSON.stringify(c.text.slice(-8))})`,
      );
    }
  }
}

// ── A bullet whose CLIP took something is detectable by the caller's guard:
// `criterionText` is idempotent-stable against its own neutralised form, which is
// how `placePiSpecSection` decides a bullet was cut.
{
  const whole = "a".repeat(CRITERION_MAX_CHARS);
  assert(criterionText(whole) === whole, "a bullet exactly at the bound is not cut");
  const over = "a".repeat(CRITERION_MAX_CHARS + 1);
  assert(criterionText(over) !== oneLine(over), "a bullet past the bound IS cut, and visibly");
}

// ── clip never splits a surrogate pair.
{
  const astral = "😀".repeat(3) + "a".repeat(CRITERION_MAX_CHARS);
  const cut = clip(astral, CRITERION_MAX_CHARS);
  assert(cut.length <= CRITERION_MAX_CHARS, "clip honours its bound in code units");
  assert(
    !/[\ud800-\udbff]$/.test(cut),
    "a trailing high surrogate is dropped rather than left dangling",
  );
}

// ── `mappingDisagrees` is what a persisted contract is checked against: only what
// the mapper itself enforces, so it cannot refuse a contract the mapper produces.
{
  const built = piSpecFromBullets(
    "p",
    Array.from({ length: 12 }, (_, i) => `b${String(i)}`),
  );
  assert(
    built !== undefined && mappingDisagrees(built) === undefined,
    "a spec the mapper produced never disagrees with the mapper — 12 bullets and all",
  );
  const mk = (n: number, size: "S" | "M" | "L") => ({
    criteria: Array.from({ length: n }, (_, i) => ({
      id: `AC${String(i + 1)}`,
      text: `c${String(i)}`,
      verify: "test" as const,
    })),
    size,
  });
  assert(
    mappingDisagrees(mk(9, "L")) === undefined,
    "a 9-criterion block honestly stamped L agrees with the mapper — whether that is too big for one run is `readiness`'s call, not this leaf's",
  );
  assert(
    mappingDisagrees(mk(9, "M"))?.includes("stamped") === true,
    "…but the same count stamped M is refused: a mapping counts the embedded criteria, so the band is derived, not declared",
  );
  assert(
    mappingDisagrees(mk(13, "L")) !== undefined,
    "…but a count past the embedding ceiling is, whatever band it carries",
  );
  assert(
    mappingDisagrees(mk(2, "M"))?.includes("stamped") === true,
    "…and a band that disagrees with the count names the stamp",
  );
}

// ── The leaf rule: this module imports only ./lean/spec.ts, and lean/ never
// reaches /plan through it. A leaf that gained an import would let `lean/` pull
// the whole drafting stack (model calls, forge, vipune) into the engine.
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "src", "pi-spec-map.ts"), "utf8");
  const imports = [...src.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((m) => m[1] as string);
  assert(
    imports.every((i) => i === "./lean/spec.ts"),
    `pi-spec-map imports only ./lean/spec.ts (got ${JSON.stringify(imports)})`,
  );
  const leanDir = path.join(import.meta.dirname, "..", "src", "lean");
  // Only the /plan drafting stack (and vipune) is out of bounds for `lean/` — the
  // forge modules are a separate matter: the lean steps already read the forge
  // through `lean/io.ts`. This gate exists for the one edge the brief forbids,
  // namely `lean/` reaching /plan's exec/vipune/forge stack through the mapper.
  const reachers = readdirSync(leanDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /from "..\/plan-|vipune/.test(readFileSync(path.join(leanDir, f), "utf8")));
  assert(
    reachers.length === 0,
    `no module under src/lean imports a /plan drafting module or vipune (got ${JSON.stringify(reachers)})`,
  );
}

process.exit(failed);
