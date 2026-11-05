#!/usr/bin/env bun
/**
 * #2031 AC2 (edge) — what the concurrency model does and does not promise.
 *
 * AC2's wording is `<name> created in $HOME during the <role> run`, and the check
 * itself is a NAME-SET difference over the top level of `$HOME` (operator decision).
 * The module header of `spawn-operator-config.ts` states the concurrency rule the
 * guard accepts for the protected files — overlapping children share one window, and
 * "the warn is the attribution" — and the listing inherits it, so a reviewer can name
 * an entry a sibling made during its window. That is the same accepted weakness,
 * spelled out here rather than papered over, and the case is driven deterministically:
 * the reviewer holds the window open and a non-reviewer child writes the only new
 * entry inside it.
 *
 * What the listing DOES promise, and what the removed attribution ledger used to be
 * the only way to test: an entry that appears only AFTER a reviewer's window has
 * closed is not named on that reviewer's result. The listing sees the home only at the
 * two ends of the run, so it cannot reach outside them — which is the same boundary
 * AC4's "compare step skipped" mutant observes from the other side.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC2-home-entry-attribution.ts";
const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

/** Run one guard; when `name` is given, its child creates it at the top level of `home`. */
async function guarded(role: string, home: string, name: string | null, holdMs = 0) {
  let res: DispatchResult | undefined;
  await withEnv({ HOME: home }, async () => {
    res = await withOperatorConfigGuard(role, async () => {
      if (name !== null) writeFileSync(path.join(home, name), "written inside the run\n");
      if (holdMs > 0) await new Promise((settle) => setTimeout(settle, holdMs));
      return result();
    });
  });
  return res;
}

const home = path.join(mkdtempSync(path.join(tmpdir(), "pi-2031-attr-")), "home");
mkdirSync(home, { recursive: true });

// --- the accepted overlap: a sibling's entry inside the reviewer's window

const reviewerWindow = (async () => guarded("code-review-specialist", home, null, 80))();
await new Promise((settle) => setTimeout(settle, 20));
const other = await guarded("developer", home, "not-the-reviewers.txt");
const reviewer = await reviewerWindow;

const entry = path.join(home, "not-the-reviewers.txt");
assert(
  existsSync(entry) && readdirSync(home).includes("not-the-reviewers.txt"),
  "AC2 attribution: the entry really exists and was made by the OTHER child",
);
assert(
  (other?.operatorConfig ?? []).length === 0,
  `AC2 attribution: the non-reviewer child is not listed (its own result stays clean) (${JSON.stringify(other?.operatorConfig ?? [])})`,
);
assert(
  reviewer?.ok === true,
  "AC2 attribution: the reviewer's own outcome is untouched by the disclosure",
);

// --- what the name-set difference does promise: it cannot see outside its window

// A second reviewer whose window opens after the sibling's write has settled: its
// baseline already holds the name, so it names nothing. This is the listing's own
// boundary — the home is read at the two ends of the run and nowhere in between.
const quiet = await guarded("code-review-specialist", home, null);
assert(
  existsSync(entry) &&
    !(quiet?.operatorConfig ?? []).some((l) => l.includes("not-the-reviewers.txt")),
  `AC2 attribution: a reviewer whose window opens after a sibling's write names nothing (${JSON.stringify(quiet?.operatorConfig ?? [])})`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);
