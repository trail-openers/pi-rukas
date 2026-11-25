/**
 * #2634 AC6 — the pre-verify share is documented, and the documentation is pinned.
 *
 * Two files carry the rule and neither is read at runtime: `docs/configuration.md`'s env row is
 * where an operator learns the lever exists, what its default is and what `0` restores;
 * `docs/lean.md` is where the skip rule and its floor are stated next to the step budgets they
 * bound. `test-headless-inputs.ts` checks the roster against the readers and never opens `docs/`,
 * so an assertion here is the only thing keeping the prose from drifting away from the gate.
 *
 * The needles are the ones a reader needs: that the bound covers the PAIR of steps before the
 * first verify, that it is a no-dispatch check and never a kill, that `0` is the only off value,
 * that the skipped round records a reason, and that the review reserve itself is unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const repo = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

const configuration = read("docs/configuration.md");
const lean = read("docs/lean.md");

/** The env table's row for one variable, so an assertion is about ITS row and not the file's. */
function envRow(name: string): string {
  const line = configuration.split("\n").find((l) => l.startsWith(`| \`${name}\` |`));
  if (line === undefined) throw new Error(`docs/configuration.md has no row for ${name}`);
  return line;
}

const row = envRow("PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE");

assert(
  row.includes("40") && row.includes("`0`"),
  `the row states the default share and the one off value (${row.slice(0, 120)}…)`,
);
assert(
  row.includes("`specify`") && row.includes("`challenge`"),
  "the row names the two steps the share bounds",
);
assert(
  row.includes("not a kill") && row.includes("child already running"),
  "the row says the bound is a check before each dispatch and never cuts a running child",
);
assert(
  row.includes("skipped") && row.includes("reason"),
  "the row says a skipped round records a reason the bench can count",
);
assert(
  row.includes("inert") && row.includes("PI_ENSEMBLE_DISPATCH_CAPS"),
  "the row says the bound is inert with no resolved deadline and under the caps master switch",
);
assert(
  row.includes("pre-verify-share-switch.ts") && row.includes("pre-verify-share.ts"),
  "the row names the reader's file and the module holding the rule",
);

assert(lean.includes("PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE"), "docs/lean.md names the switch");
assert(
  lean.includes("challenge is skipped") && lean.includes("one verify"),
  "docs/lean.md states the skip rule and the one-verify figure",
);
assert(
  lean.includes("reserve plus one verify") && lean.includes("handoffAllowanceMs"),
  "docs/lean.md states the floor as the review reserve plus one verify, read through the same helpers",
);
assert(
  lean.includes("specify") && lean.includes("every visit"),
  "docs/lean.md says the spend sums every visit in the durable step log",
);
assert(
  lean.includes("inert") && lean.includes("PI_ENSEMBLE_DISPATCH_CAPS=0"),
  "docs/lean.md keeps the inert convention the review clock uses",
);

process.exit(failures());
