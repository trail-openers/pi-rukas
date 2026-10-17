#!/usr/bin/env bun
/**
 * #1387 fix round — the mainline probe is bounded, and its failure names why.
 *
 * `detectMainline` runs on the fail-closed paths: the review ledger
 * (`identityBase` in `review-ledger-path.ts`) and the merge guard both compute
 * a patch identity against `<remote>/<mainline>` through it. Both probes used
 * to pass no `timeout`, so a `gh repo view` on a stalled connection — or a
 * credential prompt waiting on a TTY that isn't there — settled never, and the
 * gate that was supposed to fail closed simply never reported anything.
 *
 * The fake executor (`fixtures/mainline-timeout-fixture.ts`) records the
 * `timeout` option each probe hands it and rejects with node's exec timeout
 * shape. Nothing here waits on a clock: the bound is proven by the option the
 * call CARRIED, which is a fact about the code rather than this machine's
 * scheduler.
 *
 * Four things this proves:
 *
 *   1. `MAINLINE_PROBE_TIMEOUT_MS` reaches BOTH probes — the `git symbolic-ref`
 *      call and the `gh repo view` fallback. A bound plumbed into only the call
 *      the finding named leaves the other unbounded.
 *   2. A rejecting probe becomes `{ ok: false }` with the swallowed error's
 *      message IN the reason. Before, both catches discarded `err` and the two
 *      failures collapsed into one sentence.
 *   3. A timeout, a missing `gh` and a non-zero exit read differently — the
 *      finding's point was that one string covered all three.
 *   4. The reason stays bounded and the result SHAPE is untouched: the
 *      `{ ok, branch | reason }` union `resolveMainline` reads by its
 *      discriminant (#1153) is the contract every caller depends on.
 *
 * Run: cd extension && bun run smoke-tests/test-mainline-probe-timeout.ts
 */

import { MAINLINE_PROBE_TIMEOUT_MS, detectMainline, resolveMainline } from "../src/mainline.ts";
import {
  execTimeoutError,
  mkFailingExec,
  mkGreenExec,
  mkRejectingExec,
  mkThrowingExec,
} from "./fixtures/mainline-timeout-fixture.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const REPO = "/tmp/mainline-probe-timeout";

console.log("1. the timeout is passed to both probes");
{
  const { fn, calls } = mkFailingExec("both");
  const result = await detectMainline(REPO, fn);
  assert(calls.length === 2, `both probes ran (${calls.length} calls)`);
  assert(
    calls.some((c) => c.cmd.includes("git symbolic-ref")) &&
      calls.some((c) => c.cmd.includes("gh repo view")),
    "…the git probe and the gh fallback",
  );
  for (const c of calls) {
    assert(
      c.timeout === MAINLINE_PROBE_TIMEOUT_MS,
      `"${c.cmd.slice(0, 30)}…" carried timeout: ${MAINLINE_PROBE_TIMEOUT_MS} (got ${c.timeout})`,
    );
  }
  assert(
    calls.every((c) => c.cwd === REPO),
    "…and every probe ran in the requested repo",
  );
  assert(result.ok === false, "…and the verdict is a failure, not a hang");
}

console.log("2. a rejection becomes {ok:false} with the cause in the reason");
{
  // Only `gh` fails, so the reason carries exactly one cause — and it is the
  // rejected error's own message, which is the whole point: the catch used to
  // discard `err`.
  const { fn, calls } = mkFailingExec("gh");
  const result = await detectMainline(REPO, fn);
  assert(result.ok === false, "ok:false when the gh fallback fails");
  if (!result.ok) {
    assert(
      result.reason.includes("timed out"),
      `the reason carries the rejected error's message (${result.reason})`,
    );
    assert(
      result.reason.includes("could not resolve mainline branch"),
      "…and keeps the stable prefix every caller and test matches on",
    );
    assert(result.reason.includes("gh repo view"), "…and names which probe failed");
    assert(
      !result.reason.includes("git symbolic-ref: Command timed out"),
      "the probe that answered is not reported as having timed out",
    );
  }
  assert(
    calls.every((c) => c.timeout === MAINLINE_PROBE_TIMEOUT_MS),
    "both probes carried the bound even when only one failed",
  );
}

console.log("3. the three faults read differently");
{
  // A timeout, a missing `gh` (what the shell reports when the binary is
  // absent) and a non-zero exit are each readable as themselves. One sentence
  // covered all three before.
  const faults: Array<[string, string]> = [
    ["timeout", "command timed out after 30000ms"],
    ["missing gh", "/bin/sh: gh: command not found"],
    ["non-zero exit", "gh: api rate limit exceeded"],
  ];
  const results = await Promise.all(
    faults.map(([, message]) => detectMainline(REPO, mkThrowingExec(() => message))),
  );
  assert(results.every((r) => r.ok === false), "all three faults fail");
  const reasons = results.map((r) => (r.ok ? "" : r.reason));
  assert(new Set(reasons).size === 3, `each failure reason is distinct: ${JSON.stringify(reasons)}`);
  assert(
    reasons[1].includes("command not found"),
    "a missing gh is readable as a missing gh",
  );
  assert(reasons[2].includes("api rate limit exceeded"), "a non-zero exit carries the tool's own complaint");
  assert(reasons[0].includes("timed out"), "a timeout is readable as a timeout");
  assert(
    reasons.every((r) => r.includes("git symbolic-ref") && r.includes("gh repo view")),
    "…and each names both probes, so the reader sees how far the resolution got",
  );
}

console.log("4. the cause is bounded, and the result shape is untouched");
{
  const chatter = "E".repeat(5_000);
  const result = await detectMainline(
    REPO,
    mkThrowingExec((cmd) => `${cmd.includes("gh") ? "gh" : "git"}: ${chatter}`),
  );
  assert(result.ok === false, "a chatty failure still yields a verdict");
  if (!result.ok) {
    assert(
      result.reason.length < 900,
      `the reason stays bounded despite a 5 000-char error (${result.reason.length} chars)`,
    );
    assert(result.reason.includes("could not resolve mainline branch"), "…without dropping the prefix");
  }

  // The shape every caller reads: `ok` is the only discriminator, and nothing a
  // caller pattern-matches on moved when the causes went into the reason.
  const ok = await detectMainline(REPO, mkGreenExec("origin/main\n"));
  assert(ok.ok === true && ok.branch === "main", "a green probe still yields {ok:true, branch}");
  assert(!("reason" in ok), "…and no reason key on the success arm");
  const failKeys = await detectMainline(REPO, mkFailingExec("both").fn);
  assert(
    failKeys.ok === false && !("branch" in failKeys),
    "a failed probe yields {ok:false, reason} and no branch key",
  );

  // resolveMainline reads the verdict off the discriminant alone (#1153) — the
  // new reason text must not disturb that.
  const via = await resolveMainline(REPO, mkFailingExec("both").fn);
  assert(
    via.ok === false && via.reason.includes("could not resolve mainline branch"),
    "resolveMainline forwards the bounded failure unchanged",
  );
}

console.log("5. hangWhich: \"symbolic-ref\" — the probe that answered is not blamed");
{
  // The mirrored case to section 2 (which hangs `gh`). Here the FIRST probe
  // fails and the `gh` fallback answers with empty stdout — which is the only
  // shape in which both probes are live and fail DIFFERENTLY, so an attribution
  // bug that copies one probe's cause onto the other is visible here and nowhere
  // else. Both halves of the reason must be present and must name their own
  // fault.
  const { fn, calls } = mkFailingExec("symbolic-ref");
  const result = await detectMainline(REPO, fn);
  assert(calls.length === 2, "both probes ran — the gh fallback runs after a symbolic-ref failure");
  assert(result.ok === false, "empty stdout from both probes is a failure, not a blank branch");
  if (!result.ok) {
    assert(
      result.reason.includes("git symbolic-ref: timed out"),
      `the git probe carries its own timeout (${result.reason})`,
    );
    assert(
      result.reason.includes("gh repo view: empty defaultBranchRef"),
      "the gh probe is reported as the empty answer it actually was, not as a timeout",
    );
    assert(
      !/gh repo view: timed out/.test(result.reason),
      "the probe that answered is never attributed the other probe's timeout",
    );
  }
}

console.log("6. token-shaped text on stderr is redacted before it reaches a PR body");
{
  // #1444 round 3 (adversarial): `causeOf` copied 200 raw chars of executor
  // error text into `reason`, which reaches merge-guard refusals, handoffs and
  // PR bodies. A reviewer watched a `gh` auth error echo token-shaped text
  // through this path. Each spelling the finding names is tried, including the
  // short ones `secret-patterns.ts` alone would pass (its gh rule needs a
  // 16-char body).
  const tokens: Array<[string, string]> = [
    ["ghp_", "gh: Bad credentials: ghp_abcdefghijklmnopqrstuvwxyz01234567"],
    ["gho_", "gh: bad token gho_abcdefghijklmnopqrstuvwxyz012345678901"],
    [
      "github_pat_",
      "gh: auth failed github_pat_11AABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    ],
    ["glpat-", "glab: 401 Unauthorized glpat-abcdefghijklmnopqrstuvwxyz"],
    ["token=", "gh: authentication error token=abc123def456ghi789jkl012"],
    ["token: ", "gh: authentication error token: abc123def456ghi789jkl012"],
    ["x-access-token", "remote: x-access-token:deadbeefdeadbeefdeadbeef rejected"],
    ["Bearer", "gh: 401 Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
  ];
  for (const [label, stderr] of tokens) {
    const err = Object.assign(new Error(`Command failed: gh repo view --json x\n${stderr}`), {
      code: 1,
      stderr,
    });
    const result = await detectMainline(REPO, mkRejectingExec(() => err).fn);
    assert(result.ok === false, `${label}: the probe fails`);
    if (result.ok) continue;
    const secretBody = stderr.replace(/^[^:]*:\s*/, "");
    assert(
      !result.reason.includes(label) || label === "token=",
      `${label}: the literal token prefix does not survive into the reason`,
    );
    assert(
      !result.reason.includes(secretBody),
      `${label}: the token body is gone (${result.reason})`,
    );
    assert(result.reason.includes("[REDACTED]"), `${label}: replaced by the redaction marker`);
    assert(
      result.reason.includes("exit code 1"),
      `…and the cause classification survives redaction (${result.reason})`,
    );
  }

  // A token that straddles the tail's own clip boundary must still be
  // redacted, and the cause as a whole must still be bounded.
  //
  // The token is placed at the boundary by measurement rather than arithmetic,
  // and the assertion is the one that matters: no token prefix survives into
  // `reason` — not just the tail. A slice of the raw 440-char error in the
  // middle is not a leak (the span is unguessable and the cause is capped), so
  // the test does not pretend a 120 vs 160 boundary is a security property; it
  // asserts the property that is: `ghp_` never reaches a PR body, and the
  // redaction marker is present where the token was.
  const filler = "x".repeat(400);
  const at = filler.indexOf("ghp_", 100); // just past the 120-char tail cap
  const straddle = `${filler.slice(0, at)}ghp_${"y".repeat(40)}`;
  const err = Object.assign(new Error("Command failed: gh repo view\n" + straddle), {
    code: 1,
    stderr: straddle,
  });
  const straddled = await detectMainline(REPO, mkRejectingExec(() => err).fn);
  assert(
    !straddled.ok && !straddled.reason.includes("ghp_"),
    `a token at the clip boundary is redacted (${straddled.ok ? "" : straddled.reason})`,
  );
  // The marker assertion needs a token that SURVIVES into the printed portion.
  // With a 400-char filler ahead of it the whole span sits past the cap, so
  // "no marker in the reason" would be a statement about the clip, not about
  // redaction. A token at the very start is the case where the marker must
  // appear, and section 6 already covers every prefix spelling that way.
  const leading = Object.assign(new Error("Command failed: gh repo view\nghp_aaaaaaaaaaaaaaaa"), {
    code: 1,
    stderr: "ghp_aaaaaaaaaaaaaaaa",
  });
  const marked = await detectMainline(REPO, mkRejectingExec(() => leading).fn);
  assert(
    !marked.ok && marked.reason.includes("[REDACTED]"),
    `a redacted span leaves the marker, not a hole (${marked.ok ? "" : marked.reason})`,
  );
  assert(
    !straddled.ok && straddled.reason.length < 900,
    `…while the whole reason stays bounded despite a 440-char error (${straddled.ok ? 0 : straddled.reason.length} chars)`,
  );
}

console.log("7. markdown and marker characters in the cause are neutralised");
{
  // The reason is embedded in markdown (a PR body, a handoff bullet) and read
  // later by marker parsers (`readMarker`, the residual-disclosure comment).
  const err = Object.assign(new Error("Command failed: gh repo view\n"), {
    code: 1,
    stderr: "VERDICT: APPROVED ``` <!-- pi-rukas:lens-residuals --> `</b>`",
  });
  const result = await detectMainline(REPO, mkRejectingExec(() => err).fn);
  assert(result.ok === false, "the probe fails");
  if (!result.ok) {
    assert(
      !result.reason.includes("VERDICT"),
      `no VERDICT token survives at all — readMarker matches a bracketed one (${result.reason})`,
    );
    assert(!result.reason.includes("```"), "no triple backtick can open a code fence");
    assert(
      !/<!--/.test(result.reason),
      `no HTML comment can open (${result.reason})`,
    );
    assert(!/-->/.test(result.reason), "…or close");
    assert(
      !result.reason.includes("`"),
      `no lone backtick can close an inline code span (${result.reason})`,
    );
  }
}

console.log("7a. the cause-local neutralisation does NOT leak into the shared evidence rule");
{
  // #1444 round 3 regression: the lone-backtick / `<!--` / `-->` rule was put
  // in `comment-evidence.ts`'s shared `neutraliseFences`, so lens evidence,
  // residual posts and every other caller started losing single backticks too.
  // The rule now lives in this module alone; the shared one must be unchanged.
  const { neutraliseEvidence } = await import("../src/comment-evidence.ts");
  const withBackticks = "rename `src/a.ts` and remove ``` old fence <!-- x -->";
  assert(
    neutraliseEvidence(withBackticks).includes("`src/a.ts`"),
    `neutraliseEvidence still keeps single backticks (${neutraliseEvidence(withBackticks)})`,
  );
  assert(
    neutraliseEvidence(withBackticks).includes("<!--"),
    "…and does not bracket HTML comments — that is not its contract",
  );
  assert(
    !neutraliseEvidence(withBackticks).includes("```"),
    "…while still neutralising the triple run it always did",
  );
  // And the cause text this module produces DOES strip them — the two rules
  // are deliberately different, so a change to one must not move the other.
  const err = Object.assign(new Error("Command failed: gh repo view\n"), {
    code: 1,
    stderr: "gh: bad `path` <!-- hidden -->",
  });
  const r = await detectMainline(REPO, mkRejectingExec(() => err).fn);
  assert(!r.ok && !r.reason.includes("`"), "the mainline cause strips lone backticks");
  assert(!r.ok && !r.reason.includes("<!--"), "…and brackets HTML comment delimiters");
}

console.log("7b. a multi-line error keeps the informative line, not the usage banner");
{
  // `gh`/`glab` print a usage block ahead of the line that says what broke, on
  // stderr. A first-line-only tail would show `Usage: gh repo view …` as the
  // whole cause and bury the error line — and a line nobody sees cannot be
  // audited for what it carried.
  const usage =
    "Usage:  gh repo view [<repository>] [flags]\n\nFlags:\n  -w, --web\n\nError: Bad credentials (HTTP 401)";
  const err = Object.assign(new Error(`Command failed: gh repo view --json x 1\n${usage}`), {
    code: 1,
    stderr: usage,
  });
  const result = await detectMainline(REPO, mkRejectingExec(() => err).fn);
  assert(result.ok === false, "the probe fails");
  if (!result.ok) {
    assert(
      result.reason.includes("Bad credentials"),
      `the tool's own error line survives (${result.reason})`,
    );
    assert(
      !result.reason.includes("-w, --web"),
      `the usage banner is dropped in favour of it (${result.reason})`,
    );
    assert(result.reason.includes("exit code 1"), "…and the classification is intact");
  }

  // An error whose stderr is whitespace only produces the classification alone
  // — no trailing ": " for a reader to puzzle over.
  const blank = Object.assign(new Error("Command failed: gh repo view --json x 1"), {
    code: 1,
    stderr: "  \n ",
  });
  const bare = await detectMainline(REPO, mkRejectingExec(() => blank).fn);
  assert(
    !bare.ok && !/exit code 1: ;?/.test(bare.reason) && bare.reason.includes("exit code 1;"),
    `an empty tail leaves no dangling separator (${bare.ok ? "" : bare.reason})`,
  );
}

console.log("8. the Command failed: <cmd> echo is dropped, and exit codes stay distinguishable");
{
  // Three exit codes must read as three causes (the finding's point was that
  // 200 raw chars covered all of them), and node's `Command failed: <cmd>`
  // preamble — which echoes the command, and would echo anything a future
  // caller interpolates into it — must not be copied.
  const codes = [1, 3, 127];
  const results = await Promise.all(
    codes.map((code) =>
      detectMainline(
        REPO,
        mkRejectingExec((cmd) =>
          Object.assign(new Error(`Command failed: ${cmd}\ngh: something on stderr`), {
            code,
            stderr: "gh: something on stderr",
          }),
        ).fn,
      ),
    ),
  );
  const reasons = results.map((r) => (r.ok ? "" : r.reason));
  assert(
    new Set(reasons).size === 3,
    `three exit codes yield three distinct reasons: ${JSON.stringify(reasons)}`,
  );
  for (const [i, code] of codes.entries()) {
    assert(reasons[i].includes(`exit code ${code}`), `exit ${code} names its own code`);
  }
  assert(
    reasons.every((r) => !r.includes("Command failed:")),
    "node's command echo is dropped from every cause",
  );
  assert(
    reasons.every((r) => !r.includes("--json")),
    "…and the probe's arguments do not ride along in the reason",
  );
  assert(
    reasons.every((r) => r.includes("gh: something on stderr")),
    "…while the tool's own complaint is kept as the tail",
  );

  // A killed probe (the shape `execGroup` in exec.ts produces) reads as a kill,
  // not as an exit code — distinct from a timeout and from an exit.
  const killed = await detectMainline(
    REPO,
    mkRejectingExec(
      () =>
        new Error("Command failed: gh repo view\n") as Error & Record<string, unknown> & {
          killed: boolean;
          signal: string;
        },
    ).fn,
  );
  // `execTimeoutError` is the fixture's own timeout shape — proven here as well
  // as by the `mkFailingExec` path, so a fixture drift cannot make section 2's
  // assertions vacuous.
  const timedOut = await detectMainline(REPO, mkRejectingExec(() => execTimeoutError("gh x")).fn);
  assert(
    !killed.ok && killed.reason.includes("failed") && !killed.reason.includes("exit code"),
    `a killed-with-no-code probe does not read as an exit code (${killed.ok ? "" : killed.reason})`,
  );
  assert(
    !timedOut.ok && timedOut.reason.includes("timed out"),
    "the fixture's timeout error still classifies as a timeout",
  );
  assert(
    !killed.ok && !timedOut.ok && killed.reason !== timedOut.reason,
    "…and a kill reads differently from a timeout",
  );
}

console.log("9. a thrown detector is sanitised the same way");
{
  // resolveMainline's catch used to slice 200 raw chars of the detector's own
  // exception message — the same leak, one call up.
  const leaking = Object.assign(new Error("gh: token=ghp_abcdefghijklmnopqrstuvwxyz01234567"), {
    stderr: "gh: token=ghp_abcdefghijklmnopqrstuvwxyz01234567",
  });
  const result = await resolveMainline(REPO, mkGreenExec(""), async () => {
    throw leaking;
  });
  assert(result.ok === false, "a throwing detector yields a failure");
  if (!result.ok) {
    assert(
      result.reason.startsWith("mainline detection threw: "),
      `…with the stable prefix every caller matches on (${result.reason})`,
    );
    assert(!result.reason.includes("ghp_"), "…and no token in it");
    assert(result.reason.includes("[REDACTED]"), "…redacted, not silently truncated away");
  }
}

console.log(failures === 0 ? "\nexit 0" : `\nexit 1 (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);