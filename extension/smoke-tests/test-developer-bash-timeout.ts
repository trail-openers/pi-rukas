#!/usr/bin/env bun
/**
 * test-developer-bash-timeout.ts — the #2377 per-call bash bound a DEVELOPER
 * child carries, driven at the HOOK level through the same child-guards
 * fake-pi harness the reviewer arm uses (`lib/bash-timeout-harness.ts`).
 *
 * The arm exists because the same shape of stall was measured on a lean
 * `specify` child: one bash call that never returned sat 41 min until the
 * 35-min step bound killed the step, and the reviewer knob (#2140) never
 * covered it — the role is not a reviewer's. It has its own knob,
 * `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS`, and its own default.
 *
 * As in the reviewer file, what is under test is the mutation of
 * `event.input.timeout`, not Pi's enforcement of it; the hooks come from the
 * real companion, so a mutation of the hook or of its registration fails here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeveloperRole } from "../src/review-bounds.ts";
import { developerBashBoundSeconds } from "../src/review-bash-timeout.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  DEVELOPER_BOUND,
  REVIEWER_BOUND,
  call,
  developer,
  reviewer,
  throughFrozenInput,
} from "./lib/bash-timeout-harness.ts";
import { assert, exit as failureExit } from "./merge-guard-helpers.ts";

// ============================================================
// 1. The arm is armed: a never-returning call gets the bound, an oversized
//    timeout is clamped, and a smaller one the model wrote is kept.
// ============================================================
{
  const bare = await developer({}, { command: "sleep 99999" });
  assert(
    bare.timeout === DEVELOPER_BOUND,
    `a developer bash call with no timeout gets the developer bound (${DEVELOPER_BOUND}s; got ${String(bare.timeout)})`,
  );

  const clamped = await developer({}, { command: "make", timeout: 7200 });
  assert(
    clamped.timeout === DEVELOPER_BOUND,
    `a developer's larger timeout is clamped to the developer bound (got ${String(clamped.timeout)})`,
  );

  const kept = await developer({}, { command: "bun test", timeout: 240 });
  assert(
    kept.timeout === 240,
    `a developer's smaller timeout is kept — the arm only ever lowers (got ${String(kept.timeout)})`,
  );

  // The two knobs are independent: neither role may be bounded by the other's
  // knob, or one operator setting would silently change both bounds.
  const reviewerKnobAlone = await developer(
    { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "90000" },
    { command: "sleep 99999" },
  );
  assert(
    reviewerKnobAlone.timeout === DEVELOPER_BOUND,
    `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS does not bound a developer call (got ${String(reviewerKnobAlone.timeout)})`,
  );

  const developerKnobAlone = await reviewer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "90000" },
    { command: "sleep 99999" },
  );
  assert(
    developerKnobAlone.timeout === REVIEWER_BOUND,
    `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS does not bound a reviewer call (got ${String(developerKnobAlone.timeout)})`,
  );

  // R5 — the caps master switch makes the developer arm inert exactly as it
  // does the reviewer arm.
  const capsOff = await developer({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, { command: "sleep 99999" });
  assert(
    !("timeout" in capsOff),
    `PI_ENSEMBLE_DISPATCH_CAPS=0 leaves a developer call untouched (${JSON.stringify(capsOff)})`,
  );

  // A `bash` a codemode script made reaches the same handler and is bounded too.
  const nested = await developer({}, { command: "sleep 99999" }, "call_1/2");
  assert(
    nested.timeout === DEVELOPER_BOUND,
    `a developer's nested call (parentToolCallId set) is clamped (got ${String(nested.timeout)})`,
  );

  const nullInput = await call({ PI_ENSEMBLE_ROLE: "developer" }, "bash", null);
  assert(
    nullInput === null,
    `a developer call with a null input neither throws nor is written to (${JSON.stringify(nullInput)})`,
  );
}

// ============================================================
// 2. R2 — the developer reader's semantics.
// ============================================================
{
  // Unset and empty are both "the operator said default".
  const unset = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: undefined },
    { command: "sleep 99999" },
  );
  assert(
    unset.timeout === DEVELOPER_BOUND,
    `an unset developer knob is the ${DEVELOPER_BOUND}s default (got ${String(unset.timeout)})`,
  );
  const empty = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "  " },
    { command: "sleep 99999" },
  );
  assert(
    empty.timeout === DEVELOPER_BOUND,
    `an empty developer knob is the default, not garbage (got ${String(empty.timeout)})`,
  );

  // R2's golden case: "0" is the operator opting out. The call must come back
  // byte-identical to today's — no key added, no key reordered — because a
  // developer that has never been bounded must not notice the arm at all.
  const golden = { command: "bun test", timeout: 7200 } as Record<string, unknown>;
  const before = JSON.stringify(golden);
  const zero = await developer({ PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "0" }, golden);
  assert(
    JSON.stringify(zero) === before,
    `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS="0" leaves the call byte-identical (got ${JSON.stringify(zero)})`,
  );

  // Every other value outside the accepted range: no bound, and no invented one.
  for (const garbage of ["-1", "abc", "NaN", "Infinity", "1e308", "0x10", "1.5", "999", "2147484000"]) {
    const out = await developer(
      { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: garbage },
      { command: "sleep 99999" },
    );
    assert(
      !("timeout" in out),
      `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS="${garbage}" is not a whole ms count in range — no bound (got ${String(out.timeout)})`,
    );
  }

  // R2's boundary pair: the ceiling itself is accepted, and the first whole-ms
  // value ABOVE it is rejected — not by the ms test alone (2147483001 is under
  // 2147483647) but because the seconds this hook writes would round to a value
  // Pi multiplies back past its maximum and refuses to run.
  const atCeiling = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "2147483000" },
    { command: "sleep 99999" },
  );
  assert(
    atCeiling.timeout === 2_147_483,
    `the developer knob's ceiling is accepted as ${2_147_483}s (got ${String(atCeiling.timeout)})`,
  );

  for (const over of ["2147483001", "2147483647"]) {
    const out = await developer(
      { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: over },
      { command: "sleep 99999" },
    );
    assert(
      !("timeout" in out),
      `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS="${over}" rounds to seconds Pi would refuse — no bound (got ${String(out.timeout)})`,
    );
  }

  const raised = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "90000" },
    { command: "sleep 99999" },
  );
  assert(
    raised.timeout === 90,
    `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS=90000 bounds a developer to 90s (got ${String(raised.timeout)})`,
  );

  const rounded = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "1500" },
    { command: "sleep 99999" },
  );
  assert(
    rounded.timeout === 2,
    `a 1500 ms developer knob rounds UP to a whole second, never to 0 (got ${String(rounded.timeout)})`,
  );

  const floor = await developer(
    { PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "1000" },
    { command: "sleep 99999" },
  );
  assert(
    floor.timeout === 1,
    `the developer knob's 1000 ms floor is accepted as 1s (got ${String(floor.timeout)})`,
  );

  // A frozen input must not throw into the companion's fail-closed wrapper, and
  // must not block: an unbounded call beats a refused one.
  const frozen = Object.freeze({ command: "sleep 99999" }) as Record<string, unknown>;
  const frozenRun = await throughFrozenInput("developer", frozen);
  assert(
    !frozenRun.threw && !frozenRun.blocked && !("timeout" in frozen),
    `a developer call with a frozen input neither throws nor blocks (${JSON.stringify(frozenRun)})`,
  );

  // The reader itself, so the documented default and the hook's cannot drift.
  await withEnv({ PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: undefined }, async () => {
    assert(
      developerBashBoundSeconds() === DEVELOPER_BOUND,
      `the developer knob's default is ${DEVELOPER_BOUND}s / 1500000 ms (got ${String(developerBashBoundSeconds())})`,
    );
  });
  // R2's other half: the warning for a value that is neither default nor valid
  // is written exactly once and names the value — a reader called twice would
  // emit it twice, and the operator would not know which knob complained. The
  // warning seam is `traceWarn`, which writes to stderr, so stderr is captured
  // rather than a console method that only LOOKS like the warning sink.
  await withEnv({ PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "abc" }, async () => {
    const warns: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warns.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let got: number | undefined;
    try {
      got = developerBashBoundSeconds();
    } finally {
      process.stderr.write = origWrite;
    }
    assert(
      got === undefined,
      'PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS="abc" means no bound at the reader too',
    );
    const fired = warns.filter((w) => w.includes("PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS"));
    assert(
      fired.length === 1 && fired[0].includes("abc"),
      `a rejected developer knob warns once and names the value (${JSON.stringify(warns)})`,
    );
  });
  // R2, first clause: "0" is off, and off is the documented value, so it must
  // NOT warn. A warning here reads as "your knob is broken" to an operator who
  // typed the one value that means off everywhere else in this project.
  await withEnv({ PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS: "0" }, async () => {
    const warns: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warns.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let got: number | undefined;
    try {
      got = developerBashBoundSeconds();
    } finally {
      process.stderr.write = origWrite;
    }
    assert(got === undefined, 'PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS="0" means no bound');
    assert(
      warns.filter((w) => w.includes("PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS")).length === 0,
      `"0" is the documented off value, so it warns nobody (${JSON.stringify(warns)})`,
    );
  });
}

// ============================================================
// 3. R4 — the developer arm's role predicate is exact-equality single-owner:
//    the adversarial reviewer shares the word "developer" and must NOT match,
//    and the hook must agree with the predicate role by role.
// ============================================================
{
  assert(isDeveloperRole("developer") === true, "isDeveloperRole accepts the developer role itself");
  for (const near of ["adversarial-developer", "", "developer ", "Developer", "lens-fix"]) {
    assert(
      isDeveloperRole(near) === false,
      `isDeveloperRole rejects ${JSON.stringify(near)} — a substring match would bound the adversarial reviewer's bash call at the developer knob`,
    );
  }
  for (const role of ["adversarial-developer", "code-review-specialist"]) {
    const out = await call({ PI_ENSEMBLE_ROLE: role }, "bash", { command: "sleep 99999" });
    assert(
      out.timeout === REVIEWER_BOUND,
      `${role} is bounded at the REVIEWER default, never the developer's (got ${String(out.timeout)})`,
    );
  }
}

// ============================================================
// 4. R5/R6 — the knob's discoverability rows: a knob nobody can find is a knob
//    nobody can set, so each of the three surfaces is checked for it.
// ============================================================
{
  const root = path.resolve(import.meta.dirname, "..", "..");
  const configuration = readFileSync(path.join(root, "docs", "configuration.md"), "utf8");
  assert(
    /\| `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS` \| `1500000` \(25 min\)/.test(configuration),
    "docs/configuration.md carries a row for PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS at 1500000 (25 min)",
  );
  assert(
    /PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS`[^\n]*split or background/i.test(configuration),
    "the developer knob's docs row tells the child to split or background a call that needs longer",
  );
  const troubleshooting = readFileSync(path.join(root, "docs", "troubleshooting.md"), "utf8");
  // The developer paragraph is the ONLY place the troubleshooting entry can
  // carry the knob's name, and the assertion reads that paragraph alone — so
  // deleting it fails here rather than passing on the reviewer paragraph above
  // it (which does not name the developer knob at all).
  const entry = troubleshooting
    .split("\n### ")
    .find((section) => section.startsWith("A review child stuck in one bash call"));
  const developerParagraph = (entry ?? "")
    .split("\n")
    .find((line) => line.includes("PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS"));
  assert(
    !!developerParagraph &&
      /developer/i.test(developerParagraph) &&
      /PI_ENSEMBLE_DISPATCH_CAPS=0/.test(developerParagraph),
    "docs/troubleshooting.md's stuck-bash entry keeps a developer paragraph naming its knob and its inertness",
  );
  const rolePrompt = readFileSync(path.join(root, "agents-base", "developer.md"), "utf8");
  assert(
    /PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS/.test(rolePrompt) &&
      /split or background/i.test(rolePrompt),
    "agents-base/developer.md names the knob and the split-or-background move",
  );
}

console.log(`\nexit ${failureExit}`);
process.exit(failureExit);
