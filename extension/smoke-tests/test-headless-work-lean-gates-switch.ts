#!/usr/bin/env bun
/**
 * The `gates` switch and its off arm — the claim that lets the object ship on by default.
 *
 * `gates` is additive, and additive is only safe while the OFF arm is the document this
 * build wrote before the object existed. A field-absence check is not that proof:
 * `gates: undefined` is absent to a field check and present to a host that string-compares
 * the file, which is exactly how an "identical" document starts breaking a strict parser.
 * So the off arm is compared as the WHOLE serialised document, key order included — and
 * against the on arm's own serialisation with its `gates` key deleted, so the comparison
 * cannot be satisfied by both arms being equally wrong.
 *
 * The cut markers this object gained (`<name>Total` beside every capped list) belong to the
 * object and not to the document, so the off arm names them specifically: the whole-object
 * equality would pass over a `*Total` that leaked out of `gates` onto some other field, and
 * that leak is the one way the off arm could change without the object being on.
 *
 * Split from `test-headless-work-lean-gates.ts` for the §12 size cap, along the seam the
 * file's own sections drew — the switch and its two arms here, the per-field readings there.
 */

import { leanResultDocument } from "../src/headless/work-lean-result.ts";
import { leanResultGatesEnabled } from "../src/lean/result-gates-switch.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { HEAD, driveLean } from "./lib/lean-result-fixture.ts";
import { gatesLog } from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/**
 * The env keys these cases pin, restored after every case. The switch is read at call
 * time and the arms are pinned per block, so the set has to be the one the scope clears —
 * a key left set by an earlier block is a switch that silently disables the next file in
 * the same bun process.
 */
const SWITCH = "PI_ENSEMBLE_LEAN_RESULT_GATES";
const savedSwitch = process.env[SWITCH];
async function withSwitch(value: string | undefined, body: () => Promise<void>): Promise<void> {
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
  try {
    await body();
  } finally {
    if (savedSwitch === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = savedSwitch;
  }
}

// ─── (1) the switch's truth table ───────────────────────────────────────────────
// G12: only the literal "0" takes the object out. An empty value is a shell that meant
// nothing, and `false` is a value, not the token the contract names.
for (const [value, want] of [
  [undefined, true],
  ["", true],
  ["1", true],
  ["false", true],
  ["0", false],
] as const) {
  await withSwitch(value, async () => {
    assert(leanResultGatesEnabled() === want, `switch ${JSON.stringify(value)} → ${String(want)}`);
  });
}

// ─── (2) THE OFF ARM IS THE SAME DOCUMENT ──────────────────────────────────────
{
  const steps = gatesLog({
    challenge: "new-tests",
    verify: "red",
    reds: { tiers: ["fast"], criteria: ["AC1"] },
    review: "fixed",
    heads: { shippedHead: HEAD, shippedVerified: true },
  });
  const seed = await driveLean("handed-back", 10, steps);
  let on = "";
  let off = "";
  await withSwitch(undefined, async () => {
    on = JSON.stringify(leanResultDocument(seed.run, 10).doc);
  });
  await withSwitch("0", async () => {
    off = JSON.stringify(leanResultDocument(seed.run, 10).doc);
  });
  const onIssues = (JSON.parse(on).issues ?? []) as Record<string, unknown>[];
  const offIssues = (JSON.parse(off).issues ?? []) as Record<string, unknown>[];
  assert(onIssues[0]?.hasOwnProperty("gates"), "on: the projected issue carries a `gates` key");
  assert(
    !offIssues[0]?.hasOwnProperty("gates"),
    "off: no `gates` key at all — not one holding null, not one holding undefined",
  );
  assert(on !== off, "the on arm really differs from the off arm (the comparison is not vacuous)");
  const stripped = JSON.parse(on) as { issues: Record<string, unknown>[] };
  delete stripped.issues[0]?.gates;
  assert(
    off === JSON.stringify(stripped),
    "off: the whole serialised document is today's document, key order included",
  );
  // The document's own version stamp is `schemaVersion` — so the comparison asks about THAT
  // key. `JSON.parse(x).schema` was undefined on both arms, which is `===` for a document
  // that carried no stamp at all and for one whose stamp moved. A new OPTIONAL key on a
  // record whose consumers ignore unknown keys is additive, so the number a host branches
  // on must not move: if it did, every host that pins it would read the off document as a
  // different contract than the one it already handles.
  assert(
    JSON.parse(off).schemaVersion === JSON.parse(on).schemaVersion,
    `the schema stamp does not move between the arms (${String(JSON.parse(on).schemaVersion)})`,
  );
  // The cut markers belong to the object. A host that reads `gates` under the flag sees
  // them; a host on the off arm must see the bytes it saw before the object existed. The
  // equality above already makes that claim, and this names the fields specifically — a
  // `*Total` that leaked onto the off document through some other field would fail here
  // with the marker's name in the message rather than as a bare string mismatch.
  const leaked = off.match(/\w*Total"\s*:/g) ?? [];
  assert(
    leaked.length === 0,
    `off: no gates cut marker reaches the off-arm document (${JSON.stringify(leaked)})`,
  );
  // …and the on arm really does carry them, or the absence above would be proved by a
  // projection that published no markers at all.
  const published = on.match(/\w*Total"\s*:/g) ?? [];
  assert(
    published.length >= 4,
    `on: the capped lists' markers are on the serialised document (${JSON.stringify(published)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
