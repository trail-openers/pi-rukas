#!/usr/bin/env bun
/**
 * lean/publish-body — the PR description the publish step opens with.
 *
 * Split out of `test-lean-publish.ts` along the seam the module already has:
 * that file drives the STEP (real repo, real push, fake forge) and this one
 * drives the RENDERER — every assertion here is about the bytes of a body built
 * from a given record, with no git and no forge in the room. The two files
 * share `lib/lean-publish-fixture.ts`, so the cases that need the step's own
 * output (which head a body may print, which rows a verdict colours) run
 * against the same real repo there.
 *
 *   (a) text-fence's two guarantees: a fence opens and clips; `oneLine` flattens
 *       every control character and escapes the pipe that would open a column
 *   (b) the path print filter: a path carrying a space, a pipe or a tab is
 *       dropped, a well-formed one is printed in backticks
 *   (c) column order, and the honest result cell for each `verify` kind — a
 *       `command` criterion is NEVER the gate's verdict — it prints `passed
 *       (command)` only for a criterion the gate recorded as executed, and
 *       `not executed (command)` for one it did not
 *   (d) `verifiedHead` is a green verdict's claim: a red body prints its reason
 *       and says "not verified", never a head
 *   (e) a criterion id is untrusted text and goes through `oneLine` like the
 *       criterion's text does
 */

import { publishBody } from "../src/lean/publish-body.ts";
import { challengeBudgetFromLog } from "../src/lean/publish-body.ts";
import type { PublishBodyInput } from "../src/lean/publish-body.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import type { Outcome } from "../src/lean/state.ts";
import { fenceText, oneLine } from "../src/lean/text-fence.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Body lines, for the assertions that must be about a LINE, not a substring. */
function lines(body: string): string[] {
  return body.split("\n");
}

/**
 * The line an injected heading must NOT become. Inside a ` ```text ` fence a
 * `### INJ` is inert; what the renderer must refuse is the heading standing
 * UNFENCED, where it becomes a section a reader trusts.
 */
function unfenced(ls: string[], heading: string): boolean {
  let open = false;
  for (const l of ls) {
    if (/^```/.test(l)) {
      open = !open;
      continue;
    }
    if (!open && l === heading) return true;
  }
  return false;
}

/**
 * A path the body prints: the brief's print filter, applied verbatim. No
 * whitespace (a space would sit inside a table cell), no shell or markdown
 * metacharacter, no newline that could end the row.
 */
const BODY_PATH = /^[A-Za-z0-9._/-]+$/;
function printable(p: string): boolean {
  return BODY_PATH.test(p);
}

/** A minimal contract with one criterion of the given kind. */
function spec(verify: "test" | "command" | "manual", id = "AC1"): PiSpec {
  return { problem: "p", size: "S", criteria: [{ id, text: "t", verify }] };
}

/** A body built from a record, with every optional field defaulted away. */
function bodyOf(o: Omit<Partial<PublishBodyInput>, "spec"> & { spec: PiSpec }): string {
  return publishBody({
    issue: 1,
    // Required in the input type, and the value every call here means: a run
    // that never reached a verdict, so each row reads "not run".
    verifyKind: undefined,
    tests: {},
    draft: false,
    version: "1.2.3",
    models: {},
    baseSha: "a".repeat(40),
    ...o,
  });
}

// ------------------------------------------------------ (a) text-fence's guarantees
{
  const fenceOnly: unknown[] = [];
  assert(fenceText("a\nb", 100).startsWith("```text\n"), "fenceText opens a text fence");
  assert(
    fenceText("x".repeat(20), 5) === "```text\nxxxxx…\n```",
    "fenceText clips with an ellipsis",
  );
  assert(!fenceText("```` evil", 100).includes("````"), "fenceText neutralises a run of backticks");
  assert(oneLine("a\n### b\tc", 50) === "a ### b c", "oneLine flattens every control character");
  assert(
    oneLine("a\u2028b\u2029c\u0085d", 50) === "a b c d",
    "oneLine flattens the Unicode line separators U+2028/U+2029/U+0085, which are not \\p{Cc}",
  );
  assert(
    fenceText("a\u2028b\nc", 100) === "```text\na b\nc\n```",
    "fenceText flattens U+2028 but keeps the newlines a fence is allowed to hold",
  );
  assert(oneLine("a|b", 50) === "a\\|b", "oneLine escapes a pipe so a row cannot gain a column");
  assert(oneLine("a".repeat(20), 5).endsWith("…"), "oneLine clips");
  assert(fenceOnly.length === 0, "the fence cases need no fixture — they are pure");
}

// --------------------------------------------------- (b) the path print filter, and
// ----------------------------------------------------- (c) column order / result cell
{
  const paths = ["ok/test-1.sh", "bad name;rm", "bad|pipe", "bad\ttab.sh"];
  const body = bodyOf({
    spec: spec("command"),
    tests: { AC1: paths },
    verifyKind: "red",
    verifyReason: "tail",
    draft: true,
  });
  assert(
    paths.filter((p) => !printable(p)).every((p) => !body.includes(p)),
    `publishBody drops every path carrying a character it may not print (${paths.filter((p) => !printable(p)).join(" | ")})`,
  );
  assert(
    paths.filter(printable).every((p) => body.includes(`\`${p}\``)),
    "publishBody prints every path it may print",
  );
  assert(body.includes("`ok/test-1.sh`"), "publishBody prints a well-formed path");

  const row = lines(body)[6] ?? "";
  assert(
    row.startsWith("| AC1 | t | command | `ok/test-1.sh`") &&
      row.endsWith("| not executed (command) |"),
    `publishBody renders the row in the promised column order, and never calls an unrun command criterion green (${JSON.stringify(row)})`,
  );
  assert(
    !body.includes("| command | `ok/test-1.sh` | green |") &&
      !body.includes("| command | `ok/test-1.sh` | red |"),
    "publishBody does not borrow the gate's verdict for a command criterion it never executed",
  );
  assert(
    body.includes("- pi-rukas 1.2.3") && body.includes(`- base \`${"a".repeat(40)}\``),
    "publishBody stamps the version and the base sha",
  );
  assert(body.includes("- draft:"), "a draft body says why it is a draft");
}

// ------------------------------------ (c2) the result cell per verify kind, and manual
{
  const greenTest = lines(bodyOf({ spec: spec("test"), verifyKind: "green" }))[6] ?? "";
  const redTest = lines(bodyOf({ spec: spec("test"), verifyKind: "red" }))[6] ?? "";
  const noVerdict = lines(bodyOf({ spec: spec("test") }))[6] ?? "";
  const manual = lines(bodyOf({ spec: spec("manual"), verifyKind: "green" }))[6] ?? "";
  assert(greenTest.endsWith("| green |"), "a test criterion under a green reads green");
  assert(redTest.endsWith("| red |"), "a test criterion under a red reads red");
  assert(noVerdict.endsWith("| not run |"), "with no verdict the row says not run, not green");
  assert(
    manual.endsWith("| manual — needs a human |"),
    "a manual criterion asks for a human even under a green",
  );
}

// ------------------------------------------------- (d) verifiedHead is a green's claim
{
  // The renderer's half: given no head it says so rather than printing nothing,
  // and still prints the red reason. The caller's half (a red run hands in no
  // `verifiedHead` at all) is pinned end-to-end below, against the real step.
  const RED_TAIL = "the assertion at line 4 failed";
  const headSha = "b".repeat(40);
  const redBody = bodyOf({ spec: spec("test"), verifyKind: "red", verifyReason: RED_TAIL });
  assert(
    redBody.includes("not verified (draft)") && redBody.includes(RED_TAIL),
    "a renderer given no verified head says so rather than printing nothing",
  );
  const greenBody = bodyOf({
    spec: spec("test"),
    verifyKind: "green",
    verifiedHead: headSha,
  });
  assert(greenBody.includes(`\`${headSha}\``), "a green verdict prints the head it judged");

  const redRun = await runPublish({ issue: 432, verify: { kind: "red", reason: RED_TAIL } });
  assert(
    redRun.outcome?.kind === "ok",
    `(d) a red run publishes as a draft (got ${redRun.threw?.message})`,
  );
  assert(
    !lines(redRun.body).some((l) => l.startsWith("- head:") && l.includes(redRun.head)) &&
      redRun.body.includes(RED_TAIL),
    `(d) a red body prints its reason but no verified head (${lines(redRun.body).find((l) => l.startsWith("- head:"))})`,
  );
  const greenRun = await runPublish({ issue: 433, verify: { kind: "green" } });
  assert(
    lines(greenRun.body).some((l) => l.startsWith("- head:") && l.includes(greenRun.head)),
    `(d) a green body prints the head its verdict judged (${lines(greenRun.body).find((l) => l.startsWith("- head:"))})`,
  );
}

// -------------------------------------------------- (e) a criterion id is untrusted too
{
  const idBody = bodyOf({
    spec: spec("test", "AC\n### X|y"),
    verifyKind: "green",
  });
  assert(
    !unfenced(lines(idBody), "### X|y") && idBody.includes("| AC ### X\\|y |"),
    "a criterion id is flattened like every other untrusted field, never printed raw",
  );
}

// -------------------------------------- (f) a challenge budget stop is disclosed
{
  // The optional adversary round that ran out of its own ceiling no longer ends
  // the run (#1883) — it goes on to verify and publishes. The PR is then the
  // only place the reader learns the contract was never attacked, so the line is
  // printed from the step record and not printed when there was no stop.
  const stop = {
    kind: "budget" as const,
    limit: "minutes" as const,
    value: 15,
    used: 26,
    reason: "challenge stopped: minutes budget 15 exceeded (used 26)",
  };
  const step = (n: number, outcome: Outcome) => ({
    key: `434:challenge:${n}`,
    state: "challenge" as const,
    startedAt: n,
    outcome,
  });
  const budgetStep = (n: number) => ({
    key: `434:challenge:${n}`,
    state: "challenge" as const,
    startedAt: n,
    outcome: stop,
  });
  const withStop = bodyOf({
    spec: spec("test"),
    verifyKind: "green",
    challengeBudget: { limit: "minutes", value: 15 },
  });
  assert(
    lines(withStop).some(
      (l) => l === "- challenge stopped at its minutes budget (15); no extra tests were added",
    ),
    `a challenge budget stop gets its own Run line (${lines(withStop).find((l) => l.includes("challenge stopped"))})`,
  );
  const without = bodyOf({ spec: spec("test"), verifyKind: "green" });
  assert(
    !without.includes("challenge stopped"),
    "a body with no challenge stop in the record prints no such line",
  );
  const zero = bodyOf({ spec: spec("test"), challengeBudget: { limit: "turns", value: 0 } });
  assert(
    zero.includes("- challenge stopped at its turns budget (0);"),
    "the pair is printed as recorded, including a bound of 0",
  );

  // The reader is the only thing that decides the line, so it is pinned against a
  // real log: a `challenge` step carrying the typed trio, and the same trio on a
  // step that never dispatched (a forged record prints nothing).
  assert(
    challengeBudgetFromLog([step(0, stop)])?.value === 15,
    "challengeBudgetFromLog reads the trio off a challenge budget step",
  );
  assert(
    challengeBudgetFromLog([step(0, { kind: "none" })]) === undefined,
    "a challenge that found nothing is not a budget stop",
  );
  assert(
    challengeBudgetFromLog([step(0, { kind: "budget", value: 15, used: 26 })]) === undefined,
    "a stop missing its ceiling prints nothing",
  );
  assert(
    challengeBudgetFromLog([step(0, { kind: "budget", limit: "minutes", used: 26 })]) === undefined,
    "and so one missing its value",
  );
  assert(
    challengeBudgetFromLog([
      step(0, stop),
      step(1, { kind: "new-tests", frozen: {}, tests: {} }),
    ]) === undefined,
    "a later new-tests round means the stop no longer decides the line",
  );

  const run = await runPublish({
    issue: 434,
    verify: { kind: "green" },
    // `noPush` keeps the fixture's own setup push back AND leaves the forge with
    // no open PR for this head, so the step opens one and `prCreateCalls[0].body`
    // is the body this run actually wrote. With the branch already on origin the
    // step reuses the fixture's PR and sends no body at all — the assertion would
    // then pass against an empty string.
    noPush: true,
    extraSteps: [budgetStep(0)],
  });
  assert(run.threw === undefined, `(f) the step ran (got ${run.threw?.message ?? "clean"})`);
  assert(
    run.body.includes("no extra tests were added") &&
      run.body.includes("challenge stopped at its minutes budget (15)"),
    `(f) the step's own body carries the line when the log holds the stop (${JSON.stringify(run.body.split("\n").slice(-4))})`,
  );
  const clean = await runPublish({ issue: 435, verify: { kind: "green" }, noPush: true });
  assert(
    clean.threw === undefined &&
      clean.body.includes("## Run") &&
      !clean.body.includes("challenge stopped"),
    `(f) and no line when it does not (${clean.threw?.message ?? "clean"})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
