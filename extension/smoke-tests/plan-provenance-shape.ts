/**
 * plan-provenance-shape.ts — the own-key guard of the provenance marker (#1377).
 *
 * Split from test-plan-provenance.ts along the 500-line cap (AGENTS.md §12), in
 * the same shape `plan-confirm-label-scenarios.ts` takes: a module exporting one
 * async scenario function that the suite calls with its `assert`. The
 * pure-validator and filing assertions stay in the main file; what lives here is
 * the narrow, dense family of shapes where a marker can pass a shape check and
 * then NOT render — the class of bug where the digest covers bytes the body
 * never carries.
 *
 * Why own keys are load-bearing, three ways:
 *
 *   - `Object.create({ line })` — an inherited `line` satisfies a bare
 *     `typeof o.line` but the object has no line of its own, so nothing
 *     downstream enumerates one.
 *   - A marker whose pairs live on the prototype validates on an inherited read
 *     and renders nothing from `Object.keys`.
 *   - `"__proto__"` as a JSON member is an OWN key (verified: `Object.keys`
 *     lists it), so it would render — but the same key as an assignment sets the
 *     prototype instead of adding a pair, and any `structuredClone`/JSON
 *     round-trip routes it onto the prototype. The bytes that validate are then
 *     not the bytes a later reader prints. Refusing the reserved name is the only
 *     rule that keeps validate, render and digest over one set.
 *
 * Run: cd extension && bun run smoke-tests/test-plan-provenance.ts
 */
import {
  FORBIDDEN_LINE_CHARS,
  MAX_MARKER_PAIRS,
  MAX_PROVENANCE_LINE,
  isProvenanceShape,
  markerLineOf,
  renderProvenance,
  validateProvenance,
  withProvenance,
} from "../src/plan-provenance.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";

type Assert = (cond: boolean, msg: string) => void;

/**
 * The exact characters a `provenance.line` may never carry, each as a heading
 * injection. `\n`/`\r` are the two everyone remembers; `\u2028`/`\u2029` are the
 * Unicode line and paragraph separators, `\u0085` is NEL, `\u000b`/`\u000c` are
 * VT and FF — all of them end a line in some consumer, and every one of them
 * passed a CR/LF-only rule while the injected `## x` heading still landed in the
 * filed body. The list is exported (not inlined) so BOTH nets — the validator and
 * the TypeBox schema pattern — are measured against the SAME enumeration. Each
 * entry is written with `String.fromCodePoint` rather than a literal control byte
 * or a raw escape, so no formatter, editor, or copy-paste can silently replace an
 * invisible character and make the test pass for nothing — the code point is the
 * literal here, and it is printed in every failure message.
 */
const LINE_BREAKS = [0x0a, 0x0d, 0x2028, 0x2029, 0x0085, 0x000b, 0x000c].map((cp) => ({
  cp,
  name: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
  line: `ok${String.fromCodePoint(cp)}## x`,
}));

/**
 * The TypeBox pattern the registered `start_plan_driver` schema carries for
 * `provenance.line`, compiled. The schema is the SECOND net (it catches a caller
 * that bypasses the validators), so a case that the validator refuses and the
 * pattern accepts is a real hole — which is precisely how U+2028/2029/0085 got
 * through: `"^[^@<>`\\r\\n]+$"` looked like the mirror and was not one.
 */
function schemaLinePattern(): RegExp | undefined {
  const tools: RegisteredPlanTool[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
  registerPlanTool({ registerTool: (def: RegisteredPlanTool) => tools.push(def) } as any);
  const prov = tools.find((t) => t.name === "start_plan_driver")?.parameters.properties?.provenance
    ?.properties as { line?: { pattern?: string } } | undefined;
  return prov?.line?.pattern ? new RegExp(prov.line.pattern, "u") : undefined;
}

export async function provenanceShapeScenarios(assert: Assert): Promise<void> {
  const ownOnly = Object.fromEntries([
    ["b", "2"],
    ["a", "1"],
  ]) as Record<string, string>;

  assert(
    validateProvenance({ line: "ok" }).ok === false &&
      validateProvenance("string").ok === false &&
      validateProvenance(undefined).ok === false,
    "provenance: a malformed shape is refused, not coerced",
  );
  assert(
    validateProvenance({ line: "ok", marker: { Bad_Key: "v" } }).ok === false,
    "provenance: an uppercase / long marker key is refused",
  );
  assert(
    validateProvenance({ line: "ok", marker: { k: "has space" } }).ok === false,
    "provenance: a marker value with a space is refused (it would break the comment's pair list)",
  );
  assert(
    validateProvenance({ line: "ok", marker: { k: "actor@host" } }).ok === true,
    "provenance: '@' IS allowed in a marker VALUE (the prohibition is on the visible line only)",
  );
  const many = Object.fromEntries(
    Array.from({ length: MAX_MARKER_PAIRS + 1 }, (_, i) => [`k${i}`, "v"]),
  );
  assert(
    validateProvenance({ line: "ok", marker: many }).ok === false,
    `provenance: more than ${MAX_MARKER_PAIRS} pairs is refused`,
  );
  assert(
    validateProvenance({ line: "x".repeat(MAX_PROVENANCE_LINE + 1), marker: {} }).ok === false,
    `provenance: a line over ${MAX_PROVENANCE_LINE} chars is refused`,
  );
  // The line renders as the body's FIRST line, so a line terminator is a heading
  // injection: `"ok\n## Open points"` would file a `## Open points` section the
  // driver never wrote, and that heading is the one the /work intent gate reads
  // for blocking gaps. The rule covers EVERY character that can end or separate
  // a line, not just `\n`/`\r` — and it is enforced by BOTH nets, so each case
  // below is run past the validator AND the compiled schema pattern. Rejection
  // (not stripping) is the rule: a line that renders as one line has no
  // terminator to remove.
  const linePattern = schemaLinePattern();
  for (const { name, line } of LINE_BREAKS) {
    assert(
      validateProvenance({ line, marker: {} }).ok === false,
      `provenance: ${name} in the line is refused by the validator (${JSON.stringify(line)})`,
    );
    assert(
      linePattern !== undefined && linePattern.test(line) === false,
      `provenance: ${name} is refused by the TypeBox schema pattern too (${JSON.stringify(line)}) — the second net must be as wide as the first`,
    );
  }
  for (const nl of [
    "line\nwith\nnews",
    "a\rb",
    "ok\u0000nul",
    "ok\u0001ctl",
    "ok\u001funit",
    "ok\u007fdel",
    "ok\ttab",
  ]) {
    assert(
      validateProvenance({ line: nl, marker: {} }).ok === false,
      `provenance: a control character in the line is refused (${JSON.stringify(nl.slice(0, 18))})`,
    );
  }
  // The character class is exported so the TypeBox schema mirrors the SAME
  // regex rather than a hand-copied one — this assertion is what makes a drift
  // between the two nets a test failure instead of a silent second gate with a
  // narrower rule. Each character is written as an escape (not a literal control
  // byte) so a formatter or editor cannot silently replace an invisible byte.
  // Every character the class refuses, enumerated by code point rather than as a
  // literal byte (see LINE_BREAKS for why). One assertion per character so a
  // regression names the character instead of failing an all-or-nothing `every`.
  for (const cp of [0x00, 0x01, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f, 0x85, 0x2028, 0x2029]) {
    const ch = String.fromCodePoint(cp);
    assert(
      FORBIDDEN_LINE_CHARS.test(ch) === true,
      `charset: FORBIDDEN_LINE_CHARS refuses U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
  for (const ch of ["@", "<", ">", "`"]) {
    assert(
      FORBIDDEN_LINE_CHARS.test(ch) === true,
      `charset: FORBIDDEN_LINE_CHARS refuses ${JSON.stringify(ch)}`,
    );
  }
  assert(
    // The PROSE side of the class, asserted against the exported regex rather
    // than a copy of it: what is being proved is that the shipped class does not
    // swallow ordinary bytes, and a hand-written second class would prove only
    // that the copy is sane.
    FORBIDDEN_LINE_CHARS.test(
      "filed by the nightly transcript loop: run=cron-7 (v2) / path-to/some_file #1 [ok]",
    ) === false,
    "charset: an ordinary prose line is unaffected — the class is not so wide it refuses the feature",
  );
  assert(
    withProvenance("BODY", { line: "a b", marker: {} }).split("\n").length === 5,
    "render: a valid line contributes exactly one line to the body (the shape the newline rule guarantees)",
  );

  // ── the own-key family ────────────────────────────────────────────────────
  assert(
    validateProvenance({ line: "ok", marker: JSON.parse('{"__proto__":"x"}') }).ok === false,
    "provenance: a marker whose only key is __proto__ is REFUSED — it cannot round-trip",
  );
  assert(
    isProvenanceShape(Object.create({ line: "inherited", marker: { k: "v" } })) === false,
    "provenance: an object with no OWN line is not a provenance",
  );
  assert(
    validateProvenance({ line: "ok", marker: Object.create({ k: "v" }) }).ok === false,
    "provenance: a marker whose pairs live on the prototype is refused (nothing would render them)",
  );
  assert(
    validateProvenance({ line: "ok", marker: { k: 1 } }).ok === false,
    "provenance: a non-string marker value is refused",
  );
  assert(
    validateProvenance({ line: "ok", marker: { [Symbol("k")]: "v" } }).ok === false,
    "provenance: a symbol-keyed marker pair is refused — it renders and digests as nothing",
  );

  // The own-key rule must not silently become "no pairs at all": a marker that
  // validates has to survive the sort into the object the render and the digest
  // both read. `Object.fromEntries` on a fresh literal is what guarantees it —
  // a `marker[k] = val` loop with a `__proto__` key would set the prototype and
  // return an object enumerating nothing, which `JSON.stringify` (and so the
  // digest) would see as an empty marker while the caller named a pair.
  const kept = validateProvenance({ line: "l", marker: ownOnly });
  assert(
    kept.ok === true && Object.keys(kept.provenance.marker).length === 2,
    "provenance: the normalized marker keeps every admitted pair (no prototype assignment loss)",
  );
  assert(
    JSON.stringify(renderProvenance(kept.ok ? kept.provenance : undefined)) ===
      JSON.stringify({
        firstLine: "_l_",
        lastLine: "<!-- pi-rukas:provenance v1 a=1 b=2 -->",
      }),
    "digest term: render and digest read the same own-key pairs (the digest hashes renderProvenance)",
  );

  // Render and digest enumerate the SAME own keys: the pairs a marker prints are
  // exactly its own keys, in sorted order, and nothing from the prototype.
  const inherited = Object.create({ ghost: "z" }) as Record<string, string>;
  assert(
    markerLineOf({ line: "l", marker: inherited }) === "<!-- pi-rukas:provenance v1 -->",
    `render: nothing from the prototype becomes a pair (got ${markerLineOf({ line: "l", marker: inherited })})`,
  );
  // Sorting is `validateProvenance`'s job, not the renderer's: the caller's
  // insertion order must not reach the body. So the render assertion runs on
  // what the validator returned, and the unsorted input is its own case.
  const sorted = validateProvenance({ line: "l", marker: ownOnly });
  const rendered = sorted.ok ? markerLineOf(sorted.provenance) : "";
  assert(
    rendered === "<!-- pi-rukas:provenance v1 a=1 b=2 -->",
    `render: own keys only, in sorted key order regardless of caller order (got ${rendered})`,
  );
  assert(
    Object.keys(JSON.parse('{"__proto__":"x"}')).length === 1 &&
      Object.getPrototypeOf(JSON.parse('{"__proto__":"x"}')) === Object.prototype,
    "premise: a JSON __proto__ member IS an own key — so the refusal is a name rule, not a prototype fix",
  );
}
