#!/usr/bin/env bun
/**
 * #1437 — the global-option arity table must agree with the installed binary.
 *
 * Split from `test-memory-write-guard.ts`, which owns the predicate's behaviour;
 * this file owns the one assertion that needs the real binary. `-p/--project` and
 * `--db-path` take a value; `--json`/`-h`/`-V` do not. A table that disagrees with
 * the binary makes the verb unfindable: treat `-p` as valueless and
 * `vipune -p other delete 42` reads `other` as the verb; treat `--json` as taking
 * one and `vipune --json delete 42` reads `delete` as a value.
 *
 * Absence is a SKIP, named. A present binary whose `--help` broke is a FAILURE —
 * `lib/vipune-binary-probe.ts` carries that rule so no gate here can quietly
 * switch itself off, which is the fail-open shape #1437 is about.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { vipuneHelpOrSkip } from "./lib/vipune-binary-probe.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

// --------- the global-option arity table agrees with the installed binary

{
  // The verb is found by skipping the options before it, and the skip length is
  // "how many values does this option require". Get that wrong in either
  // direction and the predicate stops seeing verbs: `-p` treated as valueless
  // makes `vipune -p other delete 42` read `other` as the verb, `--json` treated
  // as taking a value makes `vipune --json delete 42` read `delete` as a value.
  // So the table is not allowed to be remembered — it is re-read from
  // `vipune --help`, the same way the verb sets are, and an upgrade that gives a
  // global option a value fails the gate instead of going quietly blind.
  // The arity table now lives in the tokenizer (the parse half of the seam);
  // the guard keeps only the policy. The gate reads whichever file holds it.
  const SRC_DIR = path.resolve(import.meta.dirname, "..", "src");
  const src = ["memory-write-guard.ts", "memory-write-tokenizer.ts"]
    .map((f) => readFileSync(path.join(SRC_DIR, f), "utf8"))
    .join("\n");
  const tableMatch = /const GLOBAL_OPTIONS[\s\S]*?=\s*\[([\s\S]*?)\n\s*\];/.exec(src);
  assert(tableMatch !== null, "the global-option table is present and parseable");
  const declared = new Map<string, number>();
  if (tableMatch) {
    for (const m of tableMatch[1].matchAll(/flags:\s*\[([^\]]*)\],\s*values:\s*(\d+)/g)) {
      const values = Number(m[2]);
      for (const f of (m[1] ?? "").matchAll(/"([^"]+)"/g)) declared.set(f[1] ?? "", values);
    }
  }
  assert(declared.size > 0, "...and declares at least one option");

  // Absence is probed with `command -v` FIRST, so the two cases cannot be
  // confused. A present binary whose help lost the heading would make
  // `slice(indexOf(...))` return "" — an empty `fromBinary`, under which BOTH
  // checks below pass for any table at all. `vipuneHelpOrSkip` turns that into a
  // throw; only a host with no binary skips. See lib/vipune-binary-probe.ts.
  const help = vipuneHelpOrSkip("Options:", "global-option arity cross-check");
  if (help !== null) {
    // A present binary whose help lost the heading would make `slice(indexOf(...))`
    // return "" — an empty `fromBinary`, under which BOTH checks below pass for
    // any table at all. That is a green gate reading nothing, so it fails here.
    const block = (help ?? "").slice((help ?? "").indexOf("Options:"));
    const fromBinary = new Map<string, number>();
    for (const m of block.matchAll(/^\s{2,}(-\w),?\s+(--?\w[\w-]*)?\s*(?:<[^>]+>)?/gm)) {
      const short = m[1];
      const long = m[2];
      const takesValue = /<[^>]+>/.test(m[0] ?? "") ? 1 : 0;
      if (short) fromBinary.set(short, takesValue);
      if (long) fromBinary.set(long, takesValue);
    }
    assert(
      fromBinary.size > 0,
      "`vipune --help` yields at least one option to cross-check — an empty parse makes every assertion below vacuous",
    );
    const mismatches: string[] = [];
    for (const [flag, values] of declared) {
      const actual = fromBinary.get(flag);
      if (actual !== undefined && actual !== values)
        mismatches.push(`${flag} ${values}!=${actual}`);
    }
    assert(
      mismatches.length === 0,
      `every declared arity matches \`vipune --help\`${mismatches.length ? ` — ${mismatches.join(", ")}` : ""}`,
    );
    // The options the binary says take a value must be in the table, or their
    // values get read as verbs.
    const missing = [...fromBinary].filter(([, v]) => v === 1).filter(([f]) => !declared.has(f));
    assert(
      missing.length === 0,
      `no value-taking global option is missing from the table${missing.length ? ` — ${missing.map(([f]) => f).join(", ")}` : ""}`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
