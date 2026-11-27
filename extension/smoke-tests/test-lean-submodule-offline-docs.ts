#!/usr/bin/env bun
/**
 * #2319 — the docs that tell an operator about an un-populated submodule say the true thing.
 *
 * The troubleshooting entry for `the test runner could not run a test file` used to end its
 * submodule bullet with `there is no flag that makes an un-populated submodule testable` and to
 * tell the reader a hand-back naming the submodule is `a network or a remote problem`. Both were
 * true of the release before the local seeding existed and are false of this one: the seeding
 * takes submodules from the superproject, so an offline host populates, and a submodule this
 * host never held is a disclosure naming the path rather than a hand-back. Prose nobody reads at
 * runtime only stays true if something greps it (R8), and the needle here is the exact sentence
 * that was wrong — a rewrite that quietly restores it fails this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SELF = "test-lean-submodule-offline-docs.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const repo = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

const troubleshooting = read("docs/troubleshooting.md");
const lean = read("docs/lean.md");

// The bullet this PR exists to amend, located by its own heading rather than by a line number.
/** The whole bullet, from its bold lead-in to the next one — a bullet wraps, a line does not. */
function bulletOn(md: string, lead: string): string {
  const at = md.indexOf(lead);
  if (at < 0) return "";
  const rest = md.slice(at);
  const end = rest.search(/\n- \*\*|\n\n[^-\s]/);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\n\s+/g, " ");
}
const bullet = bulletOn(troubleshooting, "A submodule directory that is empty");
assert(bullet !== "", "(troubleshooting) the empty-submodule bullet is still there to be read");
assert(
  !/there is no flag that makes an un-populated submodule testable/.test(bullet),
  "(troubleshooting) the bullet no longer tells the operator no flag exists",
);
assert(
  /SUPERPROJECT|superproject/.test(bullet) && bullet.includes(".git/modules"),
  "(troubleshooting) and says where they come from by default: the superproject's module store or checkout",
);
assert(
  /disclos/.test(bullet) && /never\s+held/.test(bullet),
  "(troubleshooting) and says a submodule this host never had is disclosed, not fetched",
);

// The step table row an operator reads before they read the troubleshooting entry at all.
const specifyRow = lean.split("\n").find((l) => l.startsWith("| `specify` |")) ?? "";
assert(specifyRow !== "", "(lean.md) the specify row is present");
assert(
  /SUPERPROJECT|superproject/.test(specifyRow) && /disclos/.test(specifyRow),
  "(lean.md) the row says submodules are seeded from the superproject and an absent one is disclosed",
);
assert(
  /first level|only the first level|only where this superproject already holds|only where the superproject already holds/.test(
    specifyRow,
  ),
  "(lean.md) and that the depth rule is stated: deeper levels are used only where already present",
);
process.exit(exit);
