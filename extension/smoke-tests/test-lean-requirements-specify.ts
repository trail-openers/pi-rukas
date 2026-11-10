#!/usr/bin/env bun
/**
 * lean/specify — the requirement-coverage check, driven through the real step.
 *
 * The lever's claim is that the coverage rule is CODE, not the child's word: the
 * adversary lists requirements, and the step decides whether each one maps to a
 * test it actually proved. Driven through `lib/lean-specify-fixture.ts` — a real
 * temp git repo, the real pipeline, only the model faked — so the verdict is the
 * one the step records, not one a unit test assembled.
 *
 *   (a) every behaviour and edge item maps to a file the pipeline proved red ->
 *       `ok`, and the outcome carries the coverage record (AC2);
 *   (b) a behaviour item whose mapped file came back GREEN -> the attempt is
 *       refused naming `requirement R1 has no red test`, the bounded retry fires,
 *       and the second prompt carries that line (AC2, and the retry-budget arm);
 *   (c) a preserved item pointing at an existing test that is GREEN at the head ->
 *       covered, and NOT by a red file; a red file never satisfies it (AC3);
 *   (d) a preserved item with no existing green test -> recorded uncovered with
 *       the child's reason, and NOT refused (AC3);
 *   (e) the record the step writes counts the items by kind and lists covered and
 *       uncovered ids (AC5), and it survives the state file's validator;
 *   (f) with the lever OFF the step records no requirements at all, whatever the
 *       child submitted.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { outcomeProblem } from "../src/lean/state-outcome.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  greenScript,
  makeRepo,
  redScript,
  requirement,
  runSpecify,
  submit,
  submitRequirements,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CONFIG = configWith({ fast: "true", test: RUNNER });
const BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
  },
  null,
  2,
)}
\`\`\``;

const AC1 = "tests/AC1-retry.test.sh";
const EDGE = "tests/AC1-empty.test.sh";
/** An existing project test a `preserved` item may point at. */
const PROJECT = "tests/non-transient.test.sh";

/** The base tree: the project's own green test, and nothing else. */
function repo(): { repoRoot: string; baseSha: string } {
  return makeRepo({
    "src/retry.ts": "export const retry = () => { throw new Error('nope'); };\n",
    [PROJECT]: greenScript(),
  });
}

/** The child's writes: red for whatever the case asked red, green for the rest. */
function writer(bodies: Record<string, string>, onlyFirst = true) {
  return (wt: string, dispatch: number): void => {
    // By default only the FIRST dispatch writes: the step resets the tree before a
    // retry, and a second write would give the retry the same files its predecessor
    // had, hiding whether the retry prompt — not the files — changed the outcome.
    if (onlyFirst && dispatch !== 1) return;
    mkdirSync(path.join(wt, "tests"), { recursive: true });
    for (const [rel, body] of Object.entries(bodies)) {
      writeFileSync(path.join(wt, rel), body, { mode: 0o755 });
    }
  };
}

// ── (a) every item covered -> ok, with the record on the outcome ─────────────
{
  const { repoRoot, baseSha } = repo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 101,
    config: CONFIG,
    specBody: BODY,
    requirementsOn: true,
    writes: writer({ [AC1]: redScript(), [EDGE]: redScript() }),
    toolUses: [
      submit("AC1", [AC1, EDGE]),
      submitRequirements([
        requirement("R1", "behaviour", "a transient failure is retried", [AC1]),
        requirement("R2", "edge", "an empty attempt list is accepted", [AC1]),
        requirement("R3", "preserved", "a non-transient error still fails fast", [PROJECT]),
      ]),
    ],
  });
  assert(r.threw === undefined, `(a) no throw (${r.threw?.message ?? "clean"})`);
  assert(r.outcome?.kind === "ok", `(a) every item is covered -> ok (got ${r.outcome?.kind})`);
  const rec = r.outcome?.requirements;
  assert(rec !== undefined, "(a) the outcome carries the requirement record (AC5)");
  assert(rec?.total === 3, `(a) the record counts all three items (got ${String(rec?.total)})`);
  assert(
    JSON.stringify(rec?.byKind) === JSON.stringify({ behaviour: 1, edge: 1, preserved: 1 }),
    `(a) the record counts them by kind (got ${JSON.stringify(rec?.byKind)})`,
  );
  assert(
    JSON.stringify(rec?.covered) === JSON.stringify(["R1", "R2", "R3"]),
    `(a) all three are covered (got ${JSON.stringify(rec?.covered)})`,
  );
  assert(
    JSON.stringify(rec?.uncovered) === JSON.stringify([]),
    `(a) nothing is uncovered (got ${JSON.stringify(rec?.uncovered)})`,
  );
  assert(
    rec?.items.find((i) => i.id === "R1")?.tests[0]?.red === true,
    "(a) the behaviour item records the red the pipeline proved",
  );
  assert(
    rec?.items.find((i) => i.id === "R3")?.tests[0]?.green === true,
    "(a) the preserved item records the existing test the step ran green",
  );
  assert(
    outcomeProblem({ kind: "ok", requirements: rec }, "specify") === undefined,
    "(a) the record the step wrote passes the state file's own validator",
  );
}

// ── (b) a behaviour item with no red -> refused, named by id, retried ────────
{
  const { repoRoot, baseSha } = repo();
  const prompts: string[] = [];
  // The child CLAIMS R1 and R2 with no `note`, and names a file the step cannot
  // prove red for R1 — the criterion itself stays covered by the file it did
  // write, so the pipeline COMMITS and the only thing wrong with the round is the
  // claim. That is what makes the retry attributable to the requirement rule and
  // nothing else. The list is a FUNCTION so each round submits its own objects
  // rather than sharing one array across rounds.
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 102,
    config: CONFIG,
    specBody: BODY,
    prompts,
    requirementsOn: true,
    writes: writer({ [AC1]: redScript() }),
    // The tool list is a FUNCTION: a captured array would hand the retry the
    // same `toolUses` objects the first child submitted, and shared mutable
    // state between rounds is how a step ends up judging one round's evidence
    // twice.
    toolUses: (): unknown[] => [
      submit("AC1", [AC1]),
      submitRequirements([
        requirement("R1", "behaviour", "a transient failure is retried", ["tests/absent.test.sh"]),
        requirement("R2", "edge", "an empty attempt list is accepted", [AC1]),
      ]),
    ],
  });
  assert(r.threw === undefined, `(b) no throw (${r.threw?.message ?? "clean"})`);
  // The record the step keeps is the LAST round's account, and the second round
  // wrote nothing (the step resets the tree before a retry), so nothing in it can
  // be covered. What this case needs is the record of the round that was REFUSED
  // — R1 uncovered while R2 was covered — and that is what drove the retry.
  // `dispatched` is the observable proof that a refusal happened at all; the
  // per-round coverage is pinned by (a), (c) and (d) at the record level.
  assert(
    JSON.stringify(r.outcome?.requirements?.uncovered) === JSON.stringify(["R1", "R2"]),
    `(b) the recorded list marks both behaviour and edge items uncovered after the empty retry (got ${JSON.stringify(r.outcome?.requirements?.uncovered)})`,
  );
  assert(
    r.dispatched === 2,
    `(b) the unmapped item rode the refused channel, so the retry fired (dispatched ${String(r.dispatched)})`,
  );
  const [first = "", second = ""] = prompts;
  assert(
    first.length > 1000,
    `(b) the first prompt is the adversary's kickoff, not an infra message (${String(first.length)} bytes)`,
  );
  assert(
    first.includes("## The requirement list"),
    "(b) the kickoff prompt asked for the numbered list",
  );
  assert(
    second.includes("requirement R1 has no red test"),
    "(b) the retry's prompt names the unmapped item by id (AC2, the retry-budget arm)",
  );
  assert(
    /Your previous submission was refused/.test(second),
    "(b) the gap reached the child through the existing refusal section",
  );
}

// ── (c) a preserved item is satisfied only by a GREEN existing test ───────────
{
  const { repoRoot, baseSha } = repo();
  // The child points its preserved item at its OWN red file. A red never proves a
  // behaviour still works, so the item is uncovered — and the step commits.
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 103,
    config: CONFIG,
    specBody: BODY,
    requirementsOn: true,
    writes: writer({ [AC1]: redScript() }, false),
    toolUses: [
      submit("AC1", [AC1]),
      submitRequirements([
        requirement("R1", "behaviour", "a transient failure is retried", [AC1]),
        requirement("R2", "preserved", "a non-transient error still fails fast", [AC1]),
      ]),
    ],
  });
  assert(r.threw === undefined, `(c) no throw (${r.threw?.message ?? "clean"})`);
  assert(r.outcome?.kind === "ok", `(c) a preserved gap is not a refusal (got ${r.outcome?.kind})`);
  const r2 = r.outcome?.requirements?.items.find((i) => i.id === "R2");
  assert(
    r2?.covered === false,
    `(c) a red never satisfies a preserved item (covered ${String(r2?.covered)})`,
  );
  assert(
    r2?.tests[0]?.red !== true,
    "(c) and the record says so: the item's file is not marked as its coverage",
  );
}

// ── (d) a preserved item with nothing green -> recorded, with the reason ──────
{
  const { repoRoot, baseSha } = repo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 104,
    config: CONFIG,
    specBody: BODY,
    requirementsOn: true,
    writes: writer({ [AC1]: redScript() }, false),
    toolUses: [
      submit("AC1", [AC1]),
      submitRequirements([
        requirement("R1", "behaviour", "a transient failure is retried", [AC1]),
        requirement(
          "R2",
          "preserved",
          "a non-transient error still fails fast",
          ["tests/does-not-exist.test.sh"],
          "no test in the repo covers the non-transient path",
        ),
      ]),
    ],
  });
  assert(r.threw === undefined, `(d) no throw (${r.threw?.message ?? "clean"})`);
  assert(r.outcome?.kind === "ok", `(d) the run is not refused (got ${r.outcome?.kind})`);
  assert(
    JSON.stringify(r.outcome?.requirements?.uncovered) === JSON.stringify(["R2"]),
    `(d) the gap is recorded by id (got ${JSON.stringify(r.outcome?.requirements?.uncovered)})`,
  );
  assert(
    r.outcome?.requirements?.items.find((i) => i.id === "R2")?.reason ===
      "no test in the repo covers the non-transient path",
    "(d) and with the child's own reason (AC3)",
  );
}

// ── (e) a child that named no requirements records nothing about them ─────────
{
  const { repoRoot, baseSha } = repo();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 105,
    config: CONFIG,
    specBody: BODY,
    requirementsOn: true,
    writes: writer({ [AC1]: redScript() }),
    toolUses: [submit("AC1", [AC1])],
  });
  assert(r.threw === undefined, `(e) no throw (${r.threw?.message ?? "clean"})`);
  assert(
    r.outcome?.kind === "ok" && r.outcome.requirements === undefined,
    `(e) no list submitted, so no coverage record — the step does not invent one (got ${JSON.stringify(r.outcome?.requirements)})`,
  );
}

// ── (f) lever OFF: the same submission leaves no trace in the record ──────────
{
  const { repoRoot, baseSha } = repo();
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 106,
    config: CONFIG,
    specBody: BODY,
    prompts,
    // Not requirementsOn: the switch is off, and a child that guessed the tool
    // anyway must not move the step.
    // Both dispatches write: this case asks what the LEVER did — the retry must
    // see the tree the first attempt had, not one the retry happened to refill.
    writes: writer({ [AC1]: redScript(), [EDGE]: redScript() }, false),
    toolUses: [
      submit("AC1", [AC1, EDGE]),
      submitRequirements([
        requirement("R1", "behaviour", "an empty attempt list is accepted", [EDGE]),
      ]),
    ],
  });
  assert(r.threw === undefined, `(f) no throw (${r.threw?.message ?? "clean"})`);
  assert(
    r.outcome?.kind === "ok",
    `(f) off, the child's word about the tests is what the step judged (got ${r.outcome?.kind}; reason ${String(r.outcome?.reason)})`,
  );
  assert(
    r.outcome?.requirements === undefined,
    "(f) off, the outcome carries no requirement record at all",
  );
  assert(
    r.dispatched === 1 && prompts.every((p) => !p.includes("submit_requirements")),
    `(f) off, the child was never asked for the list, whatever it guessed about the tool (dispatched ${String(r.dispatched)}, asked ${String(prompts.filter((p) => p.includes("submit_requirements")).length)}/${String(prompts.length)})`,
  );
}

// The fixture registers every repo it makes; a case that left its tree behind
// would leak a git clone per run, and the next run could read a stale base.
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
