#!/usr/bin/env bun
/**
 * #2619 — the red reason's clip keeps the tail, and the prompt says when there is nothing to fix.
 *
 * Two clippers read the same verify red and disagreed by construction: `clipReason` kept the
 * head and dropped the tail, and `build`'s re-entry clip repeated that slice with its own
 * private constant of the same size. One pytest run prints its warnings summary first and its
 * `N failed` tally last, so a head-only clip cut exactly the two things the builder needed.
 *
 * (clip)       the shared clip keeps head AND tail with an elision marker between, bounded by
 *              one constant for each half, the tail the larger; short text comes back untouched
 * (one clip)   `build`'s re-entry carries the shared function's answer rather than its own
 *              slice, so the two cannot disagree
 * (prompt)     a verify red with no readable failure line tells the builder there is nothing to
 *              fix from that text and to say so — a reason carrying a frozen or roster clause
 *              does not, because those name something to fix
 */
import { buildPrompt } from "../src/lean/build-prompt.ts";
import {
  RED_REASON_CLIP,
  RED_REASON_TAIL_CLIP,
  clipReason,
} from "../src/lean/verify-deps.ts";
import { decided } from "./lib/lean-verify-handback-log.ts";
import { ROOTS, put, runBuild } from "./lib/lean-build-fixture.ts";
import type { PiSpec } from "../src/lean/spec.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ test-2619-red-reason-clip-and-prompt.ts: ${msg}`);
    exit = 1;
  }
}

// -------------------------------------------------------------------- (clip)
{
  assert(
    RED_REASON_TAIL_CLIP > 0 && RED_REASON_TAIL_CLIP <= RED_REASON_CLIP,
    `(clip) the tail bound is a positive number no larger than the whole (${String(RED_REASON_TAIL_CLIP)} <= ${String(RED_REASON_CLIP)})`,
  );
  const head = "H".repeat(RED_REASON_CLIP);
  const tail = "T".repeat(RED_REASON_TAIL_CLIP);
  const clipped = clipReason(`${head}MIDDLE${tail}`);
  assert(clipped.includes("H"), "(clip) the head of the reason survives");
  assert(clipped.includes("T"), "(clip) the tail of the reason survives — the half a head-only clip dropped");
  assert(!clipped.includes("MIDDLE"), "(clip) what was cut is marked, not silently absent");
  assert(clipped.includes("…"), "(clip) an elision marker sits between the halves");
  assert(
    clipped.length <= RED_REASON_CLIP,
    `(clip) the whole stays inside the bound the prompt is sized for (${String(clipped.length)} <= ${String(RED_REASON_CLIP)})`,
  );
  const keptTail = clipped.slice(clipped.indexOf("…") + 1);
  assert(
    keptTail.length >= tail.length - 8,
    `(clip) the tail half keeps the tail's worth of it (${String(keptTail.length)} of ${String(tail.length)})`,
  );
  for (const short of ["", "one clause", "x".repeat(RED_REASON_CLIP)]) {
    assert(clipReason(short) === short, `(clip) text within the bound comes back byte-identical (${String(short.length)} chars)`);
  }
}

// --------------------------------------------------------------- (one clip)
{
  // The same 5 KB of text reaches the prompt through `build`'s own path. If the step still
  // held its own head-only slice, the tail here would be gone and this assertion would fail.
  const reason = `${"A".repeat(6000)}\nFAILED tests/late_test.py::test_zzz - AssertionError`;
  const r = await runBuild({
    issue: 2630,
    extraSteps: [
      decided("specify", { kind: "ok" }, 0),
      { key: "2630:verify:0", state: "verify", startedAt: 5, outcome: { kind: "red", reason } },
      { key: "2630:build:0", state: "build", startedAt: 6 },
    ],
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
  });
  const prompt = r.prompts[0] ?? "";
  assert(r.threw === undefined, `(one clip) the round ran (${r.threw?.message ?? r.outcome?.kind})`);
  assert(
    prompt.includes("FAILED tests/late_test.py::test_zzz"),
    "(one clip) the builder's prompt carries the reason's TAIL, not only its head",
  );
  assert(
    prompt.includes(clipReason(reason)),
    "(one clip) the prompt pastes the shared clip's answer verbatim, so the two cannot disagree",
  );
}

// ----------------------------------------------------------------- (prompt)
{
  const SPEC: PiSpec = {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
  };
  const promptFor = (reentry: string): string =>
    buildPrompt({
      issue: 2619,
      spec: SPEC,
      frozenPaths: ["tests/AC1-retry.test.sh"],
      worktree: "/tmp/wt",
      attempt: 1,
      reentry,
    });

  const unreadable = promptFor(
    "baseline red: tier fast is red at the base commit abc123 — `bun test` fails at the base; no failing test could be read from this output",
  );
  assert(
    /nothing to fix/i.test(unreadable),
    `(prompt) a reason that could read no failing test tells the builder so (${unreadable.match(/[^\n]*nothing to fix[^\n]*/)?.[0] ?? "no such line"})`,
  );
  assert(
    /say so/i.test(unreadable),
    "(prompt) and tells it to say that in its report rather than go hunting",
  );

  for (const named of [
    "baseline red: tier fast is red at the base commit abc123 — failing tests: FAILED tests/a.py::test_a",
    "frozen tests failing: tests/AC1.test.sh (exited 1) — and baseline red: tier fast is red at the base commit abc123",
    "the base versions of 3 edited test files fail against the head code: tests/a.test.sh",
  ]) {
    const p = promptFor(named);
    assert(
      !/nothing to fix/i.test(p),
      `(prompt) a reason that DOES name something to fix is not called empty (${named.slice(0, 50)})`,
    );
  }

  assert(
    !/nothing to fix/i.test(promptFor("verify.fast exited 1: bun test\nFAILED tests/a.py::test_a")),
    "(prompt) an ordinary tier red gets no nothing-to-fix sentence",
  );

  // The sentence keys on the clause the STEP wrote at the reason's end — never on a search of text
  // that embeds the project's own bytes. A tier can print these words, and a log line that prints
  // them must not get the builder told there is nothing to fix while a check is named above it.
  const forgedInName = promptFor(
    "baseline red: tier fast is red at the base commit abc123; failing tests: not ok 1 - no failing test could be read from this output",
  );
  assert(
    forgedInName.includes("not ok 1 - no failing test could be read from this output"),
    `(prompt) the forged name is present in the reason at all (${forgedInName.match(/failing tests:[^\n]*/)?.[0] ?? "absent"})`,
  );
  assert(
    !/nothing to fix/i.test(forgedInName),
    "(prompt) a reason that NAMES a check is not called unreadable because the project's own line says so",
  );
  const forgedInCommand = promptFor(
    "baseline red: tier fast is red at the base commit abc123 — `sh -c 'echo no failing test could be read from this output'` fails there too, so whether this run adds a failure is not known",
  );
  assert(
    !/nothing to fix/i.test(forgedInCommand),
    "(prompt) and the same words inside the quoted command are no verdict either",
  );
  // The genuine clause is position-bound: written by the step at the END, and only there.
  assert(
    /nothing to fix/i.test(
      promptFor(
        "baseline red: tier fast is red at the base commit abc123 — `bun test` fails there too, so whether this run adds a failure is not known; no failing test could be read from this output",
      ),
    ),
    "(prompt) the clause in its own position still fires the sentence",
  );
  assert(
    !/nothing to fix/i.test(
      promptFor(
        "baseline red: tier fast is red at the base commit abc123; no failing test could be read from this output; failing tests: FAILED tests/a.py::test_a",
      ),
    ),
    "(prompt) a clause that does not END the reason is not the step's clause",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
