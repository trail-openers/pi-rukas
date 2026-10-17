/**
 * #1156 — the developer test-scope + suite-bound assertions, shared by the
 * two tests that check the same rule on its two surfaces.
 *
 * `inlineDevelopPrompt` builds the `/work` develop prompt; the assembled
 * `@developer` role prompt carries the same rule from
 * `agents-base/developer.md`. The rule lives in `work-driver-verify-fast.ts`
 * (prompt) and the markdown (role prompt), and both drift independently, so
 * both files assert it. The assertions themselves are one thing, though, so
 * they live here — `test-develop-prompt-scope.ts` was pushed past the 500-line
 * cap (AGENTS.md §12) by carrying them, which is the split the size gate
 * exists to force.
 *
 * `assert` is injected rather than imported so each caller keeps its own
 * pass/fail tally and exit code.
 */

import { developTestScopeLine, suiteTimeoutSeconds } from "../../src/work-driver-verify-fast.ts";

type Assert = (cond: boolean, msg: string) => void;

const KNOB = "PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS";

/**
 * Run `body` with `PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS` set to `ms`, and
 * with it deleted when `ms` is undefined. The env is restored in a `finally`
 * so a failing assertion cannot leak the knob into the next block — a leaked
 * small watchdog would make every later "timeout 1200" assertion in the file
 * fail for a reason that has nothing to do with the code under test.
 */
function withWatchdog(ms: string | undefined, body: () => void): void {
  const saved = process.env[KNOB];
  try {
    if (ms === undefined) delete process.env[KNOB];
    else process.env[KNOB] = ms;
    body();
  } finally {
    if (saved === undefined) delete process.env[KNOB];
    else process.env[KNOB] = saved;
  }
}

/**
 * The suite-bound derivation. Asserted against the exported function rather
 * than a literal: a frozen 1200 told a developer to wrap a suite in a bound
 * LONGER than the watchdog that would then take it down, which is the
 * opposite of a bound.
 */
export function assertSuiteBoundDerivation(assert: Assert): void {
  withWatchdog(undefined, () => {
    assert(suiteTimeoutSeconds() === 1200, "derived bound: the 60-min default gives 1200s");
  });
  withWatchdog("60000", () => {
    assert(
      suiteTimeoutSeconds() === 20,
      "derived bound: a 60s watchdog shrinks the suite bound to 20s — the prompt cannot outlive the watchdog it sits under",
    );
  });
  withWatchdog("12000000", () => {
    assert(
      suiteTimeoutSeconds() === 1200,
      "derived bound: an enlarged watchdog does not stretch the prompt past the 1200s ceiling",
    );
  });
}

/**
 * The prompt-side rule, asserted against the rendered develop prompt and
 * against the exported builder directly.
 *
 * `rendered` builds a develop prompt for issue #1156 with the given verify
 * command (and fast tier) — passed in so this module does not depend on the
 * caller's workstream fixture.
 */
export function assertDevelopPromptTestScope(
  assert: Assert,
  rendered: (opts?: { verifyCmd?: string; fastCmd?: string }) => string,
): void {
  const prompt = rendered({ verifyCmd: "bun run check" });
  const noCmd = rendered();
  const withFast = rendered({
    verifyCmd: "bash smoke-tests/lib/verify-loop.sh test-*.ts",
    fastCmd: "bunx tsc --noEmit -p .",
  });

  assert(
    /smoke tests for the files you changed/i.test(prompt),
    "#1156: the developer is told to run only the smoke tests for files it changed",
  );
  assert(
    /typecheck and lint/i.test(prompt),
    "#1156: typecheck and lint stay in the developer's own scope",
  );
  assert(
    /Do NOT run the full test suite/i.test(prompt),
    "#1156: the full suite is explicitly the developer's to skip",
  );
  assert(
    /driver runs the full suite once/i.test(prompt),
    "#1156: the prompt says who does run the full suite (the driver, once)",
  );
  assert(
    prompt.includes(`timeout ${suiteTimeoutSeconds()}`),
    `#1156: every suite command carries \`timeout ${suiteTimeoutSeconds()}\` (derived from the watchdog, not a literal in the test only)`,
  );
  assert(
    /timeout 1200/.test(prompt),
    "#1156: the literal 'timeout 1200' the issue names is in the rendered prompt",
  );
  assert(
    /stuck test|stuck suite/i.test(prompt),
    "#1156: the timeout rule states the harm it prevents (a stuck test consuming the dispatch)",
  );

  // `timeout` is GNU coreutils and macOS ships none by default — but the rule
  // must not rest on that as a platform claim: it makes the child PROBE, so a
  // child on a machine that HAS a binary (coreutils via Homebrew, a Linux
  // container, a CI image) does not run its suites unbounded for no reason.
  assert(
    /probe for a timeout binary/i.test(developTestScopeLine()) &&
      /command -v timeout gtimeout/.test(developTestScopeLine()),
    "#1156 fallback: the rule tells the child to PROBE for a timeout binary rather than assert the platform",
  );
  assert(
    /gtimeout/i.test(developTestScopeLine()),
    "#1156 fallback: gtimeout (Homebrew coreutils) is named as the same tool, not a different rule",
  );
  assert(
    /only where the probe prints nothing/i.test(developTestScopeLine()),
    "#1156 fallback: the bare run is gated on the probe finding neither binary, not a platform guess",
  );
  assert(
    /run the command bare|bare.{0,60}watchdog|watchdog.{0,60}bare/i.test(developTestScopeLine()),
    "#1156 fallback: with no `timeout` the command runs bare and stays under the tool watchdog",
  );
  assert(
    /PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS/.test(developTestScopeLine()),
    "#1156 fallback: the bare-run bound names the watchdog knob, so the two timeout rules resolve to one",
  );
  assert(
    /command -v timeout gtimeout|run the command bare/i.test(prompt),
    "#1156 fallback: the fallback clause reaches the rendered develop prompt, not just the builder",
  );
  // The N>1 sibling-injection header is gated on real siblings, and the
  // caller's "N=1 default path has NO sibling block" assertion matches that
  // header's exact text. The rule must not accidentally print it.
  assert(
    !prompt.includes("Parallel workstreams"),
    "#1156: the rule does not emit the sibling-injection header (the N=1 byte-identical assertion matches that token)",
  );

  // The rule is not verifyCmd-dependent: #751's three branches all still
  // carry it, including the no-discoverable-command branch where there is no
  // project verify command at all but the child could still run the suite.
  assert(
    /no discoverable verify command/i.test(noCmd) &&
      /Do NOT run the full test suite/i.test(noCmd) &&
      /timeout 1200/.test(noCmd),
    "#1156: the rule holds on the no-verify-command branch too",
  );

  // It also holds with the #1324 fast tier present — the two rules stack
  // rather than contradict (fast tier for the project command, own smoke
  // tests for everything else).
  assert(
    /FAST verify tier/i.test(withFast) &&
      /Do NOT run the full test suite/i.test(withFast) &&
      /command -v timeout gtimeout/i.test(withFast),
    "#1156: stacks on the #1324 fast tier without contradicting it",
  );
  // Under the fast tier the verify line already forbids the project verify
  // command outright, so the test-scope rule must not read as licensing it.
  // `Wrap every suite or test command in timeout ...` is the shape that does
  // — "every" includes the one command the tier just ruled out. The ad-hoc
  // wording scopes the binding to the child's own commands and says plainly
  // that it is not permission to run the full verify.
  assert(
    /ad-hoc test commands/i.test(withFast) &&
      /not to the project verify command/i.test(withFast) &&
      !/Wrap every suite or test command/i.test(withFast),
    "#1156: with the fast tier the binding is scoped to ad-hoc test commands and does not license the full verify",
  );
  // And the two modes really do differ — otherwise the flag above is decoration.
  assert(
    /Wrap every suite or test command/i.test(noCmd) && !/ad-hoc test commands/i.test(noCmd),
    "#1156: without the fast tier the binding is the general one (no ad-hoc-only carve-out)",
  );

  // The derived bound reaches the rendered prompt, not just the builder.
  withWatchdog(undefined, () => {
    assert(
      rendered().includes("timeout 1200"),
      "#1156: the default watchdog renders `timeout 1200` in the prompt",
    );
  });
  withWatchdog("60000", () => {
    const small = rendered();
    assert(
      small.includes("timeout 20") && !small.includes("timeout 1200"),
      "#1156: a small PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS shrinks the prompt's bound — no frozen 1200 outliving the watchdog",
    );
  });

  // Mutation canary: the exported builder is what puts the text in the
  // prompt. If it ever returns an empty string the assertions above fail
  // loudly rather than passing on stale text.
  assert(
    developTestScopeLine().includes(`timeout ${suiteTimeoutSeconds()}`) &&
      /Do NOT run the full test suite/i.test(developTestScopeLine()) &&
      /probe for a timeout binary/i.test(developTestScopeLine()) &&
      /only where the probe prints nothing/i.test(developTestScopeLine()) &&
      /run the command bare/i.test(developTestScopeLine()),
    "#1156: developTestScopeLine is the single source of the rule's text INCLUDING the probe-and-bare fallback (removing the clause from the source fails here)",
  );
  // The ad-hoc-only mode is the other branch of the same builder — the canary
  // above only exercises the default, so a mutation that deletes the
  // `adHocOnly` branch entirely would still pass it.
  assert(
    /ad-hoc test commands/i.test(developTestScopeLine(true)) &&
      !/Wrap every suite or test command/i.test(developTestScopeLine(true)) &&
      /probe for a timeout binary/i.test(developTestScopeLine(true)) &&
      !/ad-hoc test commands/i.test(developTestScopeLine(false)),
    "#1156: the adHocOnly argument is what switches the binding, and both branches carry the probe fallback",
  );
}
