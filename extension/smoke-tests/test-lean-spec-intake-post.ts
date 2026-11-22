#!/usr/bin/env bun
/**
 * lean/spec-intake — who the derived contract is TOLD to, and how many times.
 *
 * `ready` puts a machine-written acceptance table on a human's issue, so the two
 * claims that make that safe are both counts rather than text:
 *
 *   (a) the HOST channel posts nothing. `PI_ENSEMBLE_HANDOFF_CHANNEL=host` means
 *       the host owns the reporting channel, and a run that posted anyway would
 *       put a second, unowned copy of a contract in front of the author. Zero is
 *       falsifiable only against a forge arm that counts one, so both arms run
 *       with the same recording seam (`setLeanCommentPoster`) and the `gh` stub
 *       logs what it was asked to post — the witness `test-lean-handoff-channel.ts`
 *       (g′) uses for `handback`.
 *   (b) the FORGE channel posts exactly once: silence would leave an author reading
 *       a PR whose criteria nobody approved, and a second post would mean the step
 *       log does not run `ready` at most once with an outcome.
 *   (c) a RESUME that drives `ready` again from a record that already carries the
 *       contract pays no second child and posts no second comment. The persisted
 *       contract exists nowhere else, so re-deriving it is both a wasted child and
 *       a DIFFERENT document for every later step to be graded on; the run's record
 *       — not a closure — is what says the derivation already happened.
 *
 * Everything is offline: a real git repo, `PI_ENSEMBLE_FORGE=none` so the forge
 * adapter is refused outright (a seam that let the call fall through to
 * `forge.issueComment` would count zero and pass for the wrong reason), and a `gh`
 * stub on PATH for the issue read. See the fixture for the seams.
 */

import { parsePiSpec } from "../src/lean/spec.ts";
import { driveIntakeReady } from "./lib/lean-spec-intake-post-fixture.ts";

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed++;
    console.log(`✗ ${label}`);
  }
}

// ── (a) the host channel posts nothing, and (b) the forge channel posts once.
{
  const host = await driveIntakeReady({ tag: "host", channel: "host" });
  assert(
    host.derives === 1 && host.posted.length === 0,
    `(a) host channel: derived once, posted ${String(host.posted.length)} in-process comments (expected 1 derive, 0 posts)`,
  );
  assert(
    host.forgePosts.length === 0,
    `(a) …and the forge was asked to post nothing either (got ${String(host.forgePosts.length)})`,
  );
  // The contract's provenance is read off the DECIDED ready step, not the run
  // object: `runLean` returns the record as it stands after the last applied
  // transition, and the derived spec is copied onto the run by the same write that
  // stamps the step.
  const readyStep = host.record?.steps.find((s) => s.state === "ready");
  assert(
    readyStep?.outcome?.kind === "ok" && host.derives === 1,
    `(a) …and the derivation really happened and was recorded (ready=${String(readyStep?.outcome?.kind)}, state=${host.state}, reason=${host.reason})`,
  );

  const forge = await driveIntakeReady({ tag: "forge", channel: "forge" });
  assert(
    forge.posted.length === 1,
    `(b) forge channel: exactly one in-process post (got ${String(forge.posted.length)})`,
  );
  // The `gh` log is the second witness: with the post seam installed the forge is
  // never reached, so this stays empty by design — its purpose is to catch a seam
  // that recorded and then fell through. It must therefore be empty on BOTH arms.
  assert(
    forge.forgePosts.length === 0,
    `(b) …and no post bypassed the seam to reach gh directly (got ${String(forge.forgePosts.length)})`,
  );
  assert(
    (forge.posted[0] ?? "").includes("pi-spec v1"),
    "(b) …and the post is the contract itself, fenced, not a note about it",
  );
  assert(
    (forge.posted[0] ?? "").includes("fixture") === false &&
      (forge.posted[0] ?? "").includes("derived by"),
    "(b) …and it names the drafting model, so a bad derivation can be traced",
  );
  assert(forge.derives === 1, `(b) …and paid for one child (got ${String(forge.derives)})`);
  // `parsePiSpec` refuses a body with two `pi-spec v1` blocks or a nested fence, so one
  // round-trip pins both: a single fence, and its JSON is the contract the run recorded.
  const back = parsePiSpec(forge.posted[0] ?? "");
  assert(
    back.ok && JSON.stringify(back.spec) === JSON.stringify(forge.record?.derivedSpec?.spec),
    `(b) …and the post holds exactly one pi-spec v1 fence that reads back to the recorded contract (${back.ok ? "parsed" : back.reason})`,
  );
}

// ── (c) a resume from a record that already holds the contract.
{
  const resume = await driveIntakeReady({ tag: "resume", channel: "forge", resumeFrom: true });
  assert(
    resume.derives === 0,
    `(c) a resumed ready pays no second deriving child (got ${String(resume.derives)})`,
  );
  assert(
    resume.posted.length === 0 && resume.forgePosts.length === 0,
    `(c) …and posts no second comment (got ${String(resume.posted.length)} in-process, ${String(resume.forgePosts.length)} at the forge)`,
  );
  assert(
    resume.record?.derivedSpec !== undefined,
    "(c) …and still holds the contract it derived in its first pass",
  );
  assert(
    resume.record?.steps.filter((s) => s.state === "ready").length === 1,
    `(c) …and the log still holds exactly one decided ready step (got ${String(resume.record?.steps.filter((s) => s.state === "ready").length)})`,
  );
}

process.exit(failed);
