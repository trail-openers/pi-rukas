#!/usr/bin/env bun
/**
 * #1414 round 3 — the checkpoint's typecheck classifier, three shapes the
 * pre-round-3 code got wrong, plus the reason the record carries.
 *
 * Split from test-work-driver-cap-checkpoint-typecheck.ts (AGENTS.md §12
 * file-size limit): that file is the round-2 story ("could not run" is not
 * "broken", and the run is bounded + slotted) and was at its cap. This one is
 * the round-3 story — three ways the classifier indicted the code for
 * something the code did not do:
 *
 *   1. a `maxBuffer` OVERFLOW reported as a timeout. Every executor in this
 *      repo stamps `killed` on BOTH kill paths (`exec-tree.ts` documents it as
 *      "True on EITHER kill path"), so a run that printed too much looked
 *      identical to a run that stalled. `isTimedOutKill` is the shared reader
 *      that separates them, and it is what this file pins.
 *   2. HOST FORK EXHAUSTION reported as a broken tree (`/bin/sh: 1: Cannot
 *      fork`, `spawn … EAGAIN`, `fork: Cannot allocate memory`). The machine
 *      had no process slot — an environment refusal, the #1277 class in a new
 *      seam — and the operator was told their code did not compile.
 *   3. the BOUND in the reason re-read from the environment at classification
 *      time rather than captured at the run, so the record could name a bound
 *      the command was never given — #1414's own two-sources-of-truth defect,
 *      one layer down.
 *
 * Plus `sanitiseReason`: the reason is child-derived text embedded in handoff
 * markdown, so control characters and unbounded length have to go.
 *
 * Every case is pure — a planted rejection shape and the verdict it must
 * produce — so each is the mutation-check for the others: reordering the
 * diagnostic and host-fork arms, or reverting `isTimedOutKill` to a bare
 * `killed` test, breaks a named case rather than passing silently.
 */

import {
  CHECKPOINT_TYPECHECK_CMD,
  classifyTypecheckRejection,
  sanitiseReason,
} from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { verifyTimeoutMs } from "../src/work-driver-verify-develop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** [label, planted rejection, expected verdict, substring the reason must carry] */
const cases: Array<[string, unknown, true | false | undefined, string]> = [
  // ---- maxBuffer overflow: killed, but NOT a timeout (#1427's lesson here)
  [
    "a maxBuffer overflow is NOT a timeout — it keeps the diagnostic verdict",
    Object.assign(new Error("stdout maxBuffer exceeded: bun x tsc --noEmit"), {
      killed: true,
      timedOutKill: false,
      overflow: "stdout",
      code: null,
      stdout: "src/a.ts(1,1): error TS2345: output was truncated",
      stderr: "",
    }),
    false,
    "",
  ],
  [
    "a maxBuffer overflow with no diagnostic is a failure, never 'killed at its bound'",
    Object.assign(new Error("stdout maxBuffer exceeded: bun x tsc --noEmit"), {
      killed: true,
      timedOutKill: false,
      overflow: "stdout",
      code: null,
      stdout: "a great deal of unremarkable compiler chatter",
      stderr: "",
    }),
    false,
    "",
  ],
  // ---- host fork exhaustion: the machine refused, so nothing was judged
  [
    "host fork exhaustion (EAGAIN) is no verdict, not 'code broken'",
    Object.assign(new Error("Command failed: bun x tsc --noEmit\n/bin/sh: 1: Cannot fork"), {
      code: 2,
      stdout: "",
      stderr: "spawn /bin/sh EAGAIN",
    }),
    undefined,
    "could not start",
  ],
  [
    "`fork: retry: Resource temporarily unavailable` is no verdict",
    Object.assign(
      new Error("Command failed: bun x tsc --noEmit\nfork: retry: Resource temporarily unavailable"),
      { code: 1, stdout: "", stderr: "" },
    ),
    undefined,
    "could not start",
  ],
  [
    "`Cannot allocate memory` from a failed fork is no verdict",
    Object.assign(new Error("Command failed: bun x tsc --noEmit\nfork: Cannot allocate memory"), {
      code: 1,
      stdout: "",
      stderr: "",
    }),
    undefined,
    "could not start",
  ],
  [
    "fork exhaustion outranks TS output — a partial fan-out is not a verdict",
    Object.assign(
      new Error(
        "Command failed: bun x tsc --noEmit\n/bin/sh: fork: retry: Resource temporarily unavailable",
      ),
      {
        code: 2,
        stdout: "src/a.ts(1,1): error TS2345: printed before the host said no",
        stderr: "",
      },
    ),
    undefined,
    "could not start",
  ],
  // ---- a tsc message containing that phrase is NOT a timeout (#1414 round 3):
  // the `timedOutKill` / `overflow` flags are the contract, and the message is
  // the compiler's own prose. Pre-round-3 the classifier ORed a
  // `/timed out after/i.test(message)` into the timeout arm, so a run that
  // merely PRINTED that phrase was reported to the operator as a stalled run
  // whose bound fired — with no bound having fired, and no flags set.
  [
    "a tsc message containing 'timed out after' is NOT a timeout — the flags are the contract",
    Object.assign(
      new Error(
        "Command failed: bun x tsc --noEmit\nsrc/a.ts(1,1): error TS2345: the word 'timed out after' appears in a string literal",
      ),
      {
        code: 2,
        // `killed` false and NO `timedOutKill` / `overflow` — a plain non-zero
        // exit. Only the message mentions a timeout, and a message is not a kill.
        killed: false,
        stdout: "src/a.ts(1,1): error TS2345: match against 'command timed out after 5000ms'",
        stderr: "",
      },
    ),
    false,
    "",
  ],
  [
    "a message that only says 'timed out after', with no TS output and no flags, is a failure, never a bound kill",
    Object.assign(new Error("tsc printed 'command timed out after 1ms' in its summary line"), {
      code: 1,
      killed: false,
      stdout: "compilation finished; nothing to report",
      stderr: "",
    }),
    false,
    "",
  ],
  [
    "a REAL timeout still reads as one — the flags, not the message, carry it",
    Object.assign(new Error("command timed out after 600000ms: bun x tsc --noEmit"), {
      killed: true,
      timedOutKill: true,
      code: null,
      stdout: "",
      stderr: "",
    }),
    undefined,
    "killed at its",
  ],
];

for (const [label, err, wantVerdict, wantText] of cases) {
  let got: ReturnType<typeof classifyTypecheckRejection> | "THREW" = "THREW";
  try {
    // #1414 round 3 — `timeoutMs` is a REQUIRED parameter: the only way this
    // pure-classifier call can name a bound is for the test to supply one, which
    // is what makes "the bound comes from the caller, never from the environment"
    // observable. A dropped parameter here is a compile error, not a silent
    // environment read.
    got = classifyTypecheckRejection(err, verifyTimeoutMs());
  } catch {
    /* asserted below */
  }
  if (got === "THREW") {
    assert(false, `classifier never throws — ${label}`);
    continue;
  }
  assert(got.verdict === wantVerdict, `classifier: ${label} → verdict ${String(wantVerdict)}`);
  if (wantText) {
    const why = got.verdict === undefined ? got.why : "";
    assert(
      why.includes(wantText),
      `classifier: ${label} names the reason ("${wantText}") in why (got ${JSON.stringify(why)})`,
    );
  }
}

// ---- the bound the reason names is the bound the CALLER passed, captured at
// the run — not one the classifier re-reads from the environment.
{
  const killed = Object.assign(
    new Error(`command timed out after 42000ms: ${CHECKPOINT_TYPECHECK_CMD}`),
    { killed: true, timedOutKill: true, code: null, stdout: "", stderr: "" },
  );
  const a = classifyTypecheckRejection(killed, 42_000);
  assert(
    a.verdict === undefined && a.why.includes("42s"),
    `classifier: the caller's bound (42s) is what the reason names (got ${JSON.stringify(a)})`,
  );
  const b = classifyTypecheckRejection(killed, 900_000);
  assert(
    b.verdict === undefined && b.why.includes("15-min") && !b.why.includes("42s"),
    `classifier: a different caller bound yields a different reason — threaded, not read from env (got ${JSON.stringify(b)})`,
  );
  assert(
    a.verdict === undefined && b.verdict === undefined && a.why !== b.why,
    "classifier: the two calls did not collapse to one environment-derived string",
  );
}

// ---- the reason is embedded in handoff markdown, so it is sanitised.
{
  const nasty = classifyTypecheckRejection(
    Object.assign(
      new Error(
        "Command failed: bun x tsc --noEmit\nsh: tsc: command not found\n\u001b[31m  \n\t at line 7",
      ),
      { code: 127, stdout: "", stderr: "" },
    ),
  );
  assert(
    nasty.verdict === undefined &&
      !/[\n\r\t\u0000-\u001f]/.test(nasty.why) &&
      !nasty.why.includes("\u001b"),
    `sanitise: control characters and newlines are gone from why (got ${JSON.stringify(nasty)})`,
  );
  const long = classifyTypecheckRejection(
    // "not found" at end-of-message is the shell's own refusal shape, so this
    // reaches the `could not run` arm — the arm whose reason embeds the
    // command's first line verbatim, which is the one that needs bounding.
    Object.assign(new Error(`sh: tsc: ${"x".repeat(5000)} not found`), { code: 127 }),
  );
  assert(
    long.verdict === undefined && long.why.length <= 200,
    `sanitise: why is bounded in length (got ${long.verdict === undefined ? long.why.length : "n/a"})`,
  );
  assert(
    sanitiseReason("  a\n\nb   c  ") === "a b c",
    `sanitise: whitespace collapses and the string trims (got ${JSON.stringify(sanitiseReason("  a\n\nb   c  "))})`,
  );
  assert(
    sanitiseReason("z".repeat(500)).length === 200,
    "sanitise: the bound is the documented 200 characters",
  );
  // Mutation direction: an ordinary reason passes through untouched, so the
  // sanitiser sanitises rather than erases.
  assert(
    sanitiseReason("could not run (sh: tsc: command not found)") ===
      "could not run (sh: tsc: command not found)",
    "sanitise: an ordinary reason is untouched",
  );
}

// ---- #1414 round 3 (b): the `verdict: false` DETAIL is sanitised too. `why`
// has been through `sanitiseReason` since the field shipped; `detail` had not,
// so the SAME child output broke the handoff's list item in one field and not
// the other — and `detail` is the one that reaches the operator as "Last output:
// …" in the status file. Both fields land in the same two markdown surfaces, so
// both get the same treatment.
{
  const nasty = classifyTypecheckRejection(
    Object.assign(
      new Error("Command failed: bun x tsc --noEmit"),
      {
        code: 2,
        stdout:
          "src/a.ts(1,1): error TS2345: first line\n\u001b[31m  indented continuation\t\nsrc/b.ts(2,2): error TS2322: tail\n",
        stderr: "",
      },
    ),
    verifyTimeoutMs(),
  );
  assert(
    nasty.verdict === false,
    `detail-sanitise: the diagnostic still produces a verdict (got ${JSON.stringify(nasty)})`,
  );
  if (nasty.verdict === false) {
    assert(
      !/[\n\r\t\u0000-\u001f]/.test(nasty.detail) && !nasty.detail.includes("\u001b"),
      `detail-sanitise: no control characters or newlines survive in detail (got ${JSON.stringify(nasty.detail)})`,
    );
    assert(
      nasty.detail.includes("TS2345") && nasty.detail.includes("TS2322"),
      `detail-sanitise: sanitising does not drop the diagnostics themselves (got ${JSON.stringify(nasty.detail)})`,
    );
    assert(
      nasty.detail.length <= 200,
      `detail-sanitise: detail is bounded like why (got ${nasty.detail.length})`,
    );
  }
  // Mutation direction: an ordinary detail keeps the diagnostic verbatim and
  // single-line (the message is joined in as evidence, so the assertion is on the
  // diagnostic appearing whole and free of control characters, not on equality).
  const plain = classifyTypecheckRejection(
    Object.assign(new Error("Command failed: bun x tsc --noEmit"), {
      code: 2,
      stdout: "src/a.ts(1,1): error TS2345: not assignable",
      stderr: "",
    }),
    verifyTimeoutMs(),
  );
  assert(
    plain.verdict === false &&
      plain.detail.startsWith("src/a.ts(1,1): error TS2345: not assignable") &&
      !/[\n\r\t]/.test(plain.detail),
    `detail-sanitise: an ordinary diagnostic passes through whole on one line (got ${JSON.stringify(plain)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
