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
  mkFailingExec,
  mkGreenExec,
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

console.log(failures === 0 ? "\nexit 0" : `\nexit 1 (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
