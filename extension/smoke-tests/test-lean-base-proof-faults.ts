#!/usr/bin/env bun
/**
 * lean/base-proof, round 2 — what a git that never ran, or one that contradicts
 * itself, is worth.
 *
 * Split out of `test-lean-base-proof.ts` at AGENTS.md §12's line cap: the two
 * files are one suite over one source, divided along the seam between the
 * ORIGINAL contract (that file: the two rules, the wordings that mean "absent",
 * the `chmod 000` fault) and the three round-2 findings this file pins. The
 * `probeCommitObject` catch is the code under test in both, and neither repeats
 * the other's cases.
 *
 *   (j) a git that never RAN is a fault decided from the rejection's shape — a
 *       kill, a signal, an ENOENT, a non-numeric `code` — each with its own
 *       classified cause, and never the object-store wording. These shapes carry
 *       no exit code, so a classifier that asked "exit 1 or 128?" first would
 *       fall through and word an absent git binary as a damaged store;
 *   (k) the second opinion CONTRADICTING the first (`cat-file -e` exits 0 behind
 *       a resolution miss) is a fault too — the object exists, the resolution
 *       broke — and never "not a commit";
 *   (l) the resolver's answer is a PER-CALL value, not a process-global counter:
 *       a failure attributed to one resolution does not turn a later, unrelated
 *       silent refusal into a fault, and the shape itself is pinned — a caught
 *       git error reports `failed: true`, a name that simply has no commit behind
 *       it reports `failed: false`, and a leading dash never reaches git at all;
 *   (m) the round-2 wordings in both directions: `ambiguous argument` / `unknown
 *       revision` stay refusals, `unable to unpack` / inflate / corrupt / `bad
 *       object` stay faults, and a blob carrying both is a fault;
 *   (n) the resolver's `failed` is live: THIS call's failing resolution does make
 *       silence a fault, which is the other half of the per-call rule (l) pins;
 *   (o) a NEW run refuses a seed base that is neither empty nor a full commit
 *       sha, so the record can never carry a base the loader would go on to
 *       reject.
 *
 * Everything goes through `lib/lean-base-proof-fixtures.ts`'s stand-in git, and
 * every case asserts on the argv that was asked for.
 */

import { isFullCommitSha } from "../src/commit-sha.ts";
import { proveBaseSha } from "../src/lean/base-proof.ts";
import { runLean } from "../src/lean/engine.ts";
import { resolveHeadSha, resolveHeadShaOutcome } from "../src/review-head-sha.ts";
import {
  enoentGit,
  fakeGit,
  isCatFileProbe,
  isRevParse,
  killedByTimeout,
  killedGit,
  oddCodeGit,
} from "./lib/lean-base-proof-fixtures.ts";
import { HAPPY, makeAssert, scripted, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const OID = "0123456789abcdef0123456789abcdef01234567";
const REPO = "/tmp/not-a-real-repo";

// ── (j) a killed or absent git is a FAULT, decided from the rejection's shape
// and never from an exit code it does not have.
//
// Each shape arrives with no numeric `code`, so an implementation that asked
// "exit 1 or 128?" first and only then looked at the rest would fall through to
// the catch-all arm and word a SIGKILL, an oom-killed git or a missing git
// binary as `git object store unreadable` — which sends an operator to repair a
// store that is fine. Each is classified by its own cause.
for (const [label, reply, cause] of [
  ["a git the OS killed", killedGit("SIGTERM"), "git was killed (signal SIGTERM)"],
  ["the wrapper's own timeout kill", killedByTimeout(), "git was killed"],
  ["a git that never started", enoentGit(), "git did not start (spawn git ENOENT)"],
  ["a rejection with a non-numeric code", oddCodeGit(), "git did not exit normally"],
] as const) {
  const { exec, calls } = fakeGit([{ stdout: "" }, reply]);
  let thrown: unknown;
  let out: Awaited<ReturnType<typeof proveBaseSha>> | undefined;
  try {
    out = await proveBaseSha(REPO, OID, exec);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error,
    `${label} throws rather than refusing (got ${JSON.stringify(out)})`,
  );
  const msg = (thrown as Error)?.message ?? "";
  assert(
    msg.startsWith(`could not verify base sha ${OID}: ${cause}`),
    `${label} is classified by its own cause, not as an unreadable store (got ${JSON.stringify(msg)})`,
  );
  assert(
    !msg.includes("object store unreadable"),
    `${label} is never worded as an object-store problem (got ${JSON.stringify(msg)})`,
  );
  assert(
    !msg.includes("not a commit"),
    `${label} is never worded as a refusal (got ${JSON.stringify(msg)})`,
  );
  assert(
    calls.length === 2 && isCatFileProbe(calls[1]?.argv ?? []),
    `the second opinion ran before the throw for ${label} (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (k) the second opinion CONTRADICTING the first is a fault, not a refusal.
//
// `rev-parse --verify --quiet <sha>^{commit}` printed nothing and `cat-file -e`
// exited 0: the object is in the store and the resolution read is what broke.
// Refusing here would post "your base is not a commit" on an issue whose commit
// demonstrably exists, which is the same class of lie the fault arm exists to
// prevent — it just arrives through the success arm instead of the catch.
{
  const { exec, calls } = fakeGit([{ stdout: "" }, { stdout: "", stderr: "" }]);
  let thrown: unknown;
  let out: Awaited<ReturnType<typeof proveBaseSha>> | undefined;
  try {
    out = await proveBaseSha(REPO, OID, exec);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error &&
      (thrown as Error).message.startsWith(
        `could not verify base sha ${OID}: git answered the object but not the resolution`,
      ),
    `a cat-file success behind a resolution miss throws (got ${JSON.stringify(out)} / ${JSON.stringify((thrown as Error)?.message)})`,
  );
  assert(
    calls.length === 2 && isCatFileProbe(calls[1]?.argv ?? []),
    `the contradiction is discovered by running the peel (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (l) the resolver's answer is a PER-CALL value, not a process-global counter.
//
// The old shape kept a monotonic module counter in `review-head-sha.ts` and the
// proof compared it against a baseline taken just before its own read. A baseline
// made the QUESTION per-call while leaving the ANSWER global — and the answer is
// what had to be per-call: with the counter gone, a failure attributed to one
// resolution can no longer be read as evidence about another call's silence. The
// first block below makes that attribution explicit through the new outcome
// shape; the second drives the exact case the counter used to decide, and it now
// holds for the strongest possible reason — the proof never asks another call's
// question at all.
{
  const armed = fakeGit([{ throw: { code: 1, stderr: "fatal: bad revision" } }]);
  const unrelated = await resolveHeadShaOutcome("/tmp/unrelated-repo", OID, armed.exec);
  assert(
    unrelated.sha === undefined && unrelated.failed === true,
    `the unrelated resolution reports its own git failure (got ${JSON.stringify(unrelated)})`,
  );
  // Same proof, same empty-stderr refusal, with a FAILED resolution already in
  // the process — the shape that used to be decided by a global counter. It must
  // REFUSE, not throw.
  const { exec, calls } = fakeGit([{ stdout: "" }, { throw: { code: 1, stderr: "" } }]);
  let thrown: unknown;
  let out: Awaited<ReturnType<typeof proveBaseSha>> | undefined;
  try {
    out = await proveBaseSha(REPO, OID, exec);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown === undefined,
    `an unrelated failed resolution does not turn this call's silence into a fault (${String(thrown)})`,
  );
  assert(
    out?.ok === false && out.rule === `base sha ${OID} is not a commit in this clone`,
    `the silent refusal still answers after an unrelated failure (got ${JSON.stringify(out)})`,
  );
  assert(
    calls.length === 2 && isCatFileProbe(calls[1]?.argv ?? []),
    "the second opinion still ran for the silent refusal",
  );
}

// ── (l2) the outcome shape itself: what `failed` means, and what it does not.
//
// `failed` is "the resolver CAUGHT a git error", and the distinction is the
// whole reason the outcome exists: a name that peels to no commit is an ANSWER
// (`failed: false`) and the proof must be allowed to refuse, while a rejection
// is the absence of an answer (`failed: true`). A leading dash is refused before
// git is asked at all — an argument-injection guard, not a git fault — so it is
// `failed: false` and costs no subprocess.
{
  const refused = fakeGit([{ throw: { code: 128, stderr: "fatal: bad revision" } }]);
  const caught = await resolveHeadShaOutcome(REPO, OID, refused.exec);
  assert(
    caught.sha === undefined && caught.failed === true,
    `a caught git error reports failed (got ${JSON.stringify(caught)})`,
  );
  assert(
    refused.calls.length === 1 && isRevParse(refused.calls[0]?.argv ?? []),
    `the failed resolution asked git once (got ${JSON.stringify(refused.calls.map((c) => c.argv))})`,
  );

  const absent = fakeGit([{ stdout: "" }]);
  const answered = await resolveHeadShaOutcome(REPO, OID, absent.exec);
  assert(
    answered.sha === undefined && answered.failed === false,
    `an empty answer is no-such-ref, not a git failure (got ${JSON.stringify(answered)})`,
  );

  const hit = fakeGit([{ stdout: `${OID}\n` }]);
  const ok = await resolveHeadShaOutcome(REPO, OID, hit.exec);
  assert(
    ok.sha === OID && ok.failed === undefined,
    `a resolved ref reports its sha and no failure (got ${JSON.stringify(ok)})`,
  );

  const neverRan = fakeGit([{ stdout: OID }]);
  const dashed = await resolveHeadShaOutcome(REPO, "-h", neverRan.exec);
  assert(
    dashed.sha === undefined && dashed.failed === false,
    `a leading dash is refused without asking git (got ${JSON.stringify(dashed)})`,
  );
  assert(
    neverRan.calls.length === 0,
    `the dash guard runs git never to be asked (got ${JSON.stringify(neverRan.calls.map((c) => c.argv))})`,
  );

  // The wrapper keeps its exact old contract for the ~15 callers that only ask
  // "did it resolve": every outcome above collapses to the same value.
  const stillUndefined = await resolveHeadSha(REPO, OID, fakeGit([{ stdout: "" }]).exec);
  const stillTheSha = await resolveHeadSha(REPO, OID, fakeGit([{ stdout: OID }]).exec);
  assert(
    stillUndefined === undefined && stillTheSha === OID,
    `resolveHeadSha still returns string | undefined (got ${JSON.stringify([stillUndefined, stillTheSha])})`,
  );
}

// ── (m) the round-2 wordings, in both directions.
//
// `ambiguous argument` / `unknown revision` are git's rev-parse wordings for a
// name with no object behind it and stay REFUSALS; `unable to unpack` / inflate
// text / a corrupt loose object / `bad object` are a damaged store and stay
// FAULTS. The rows that print both are the ones that matter: an unreadable store
// prints its own lines alongside git's "no such object" wording, and the fault
// must win — a classifier that asked the absence question first would post "your
// base is not a commit" on an issue whose objects are corrupt.
for (const [label, stderr, kind] of [
  [
    "ambiguous argument",
    `fatal: ambiguous argument '${OID}^{commit}': unknown revision or path not in the working tree.\n`,
    "refusal",
  ],
  ["unknown revision", `fatal: unknown revision '${OID}^{commit}'\n`, "refusal"],
  [
    "unable to unpack",
    `error: unable to unpack ${OID}\nfatal: Not a valid object name ${OID}^{commit}\n`,
    "fault",
  ],
  ["inflate", "error: inflate() failed -5\n", "fault"],
  ["corrupt", `error: loose object ${OID} (stored in .git/objects/01/23…) is corrupt\n`, "fault"],
  ["fatal: loose object", `fatal: loose object ${OID} is corrupt\n`, "fault"],
  ["bad object", `fatal: bad object ${OID}\n`, "fault"],
] as const) {
  for (const code of [1, 128] as const) {
    const { exec } = fakeGit([{ stdout: "" }, { throw: { code, stderr } }]);
    let thrown: unknown;
    let out: Awaited<ReturnType<typeof proveBaseSha>> | undefined;
    try {
      out = await proveBaseSha(REPO, OID, exec);
    } catch (err) {
      thrown = err;
    }
    if (kind === "refusal") {
      assert(
        thrown === undefined &&
          out?.ok === false &&
          out.rule === `base sha ${OID} is not a commit in this clone`,
        `${label} at exit ${code} is a refusal, not a fault (got ${JSON.stringify(out)} / ${String(thrown)})`,
      );
    } else {
      assert(
        thrown instanceof Error &&
          (thrown as Error).message.startsWith(
            `could not verify base sha ${OID}: git object store unreadable (exit ${code}): `,
          ),
        `${label} at exit ${code} is a fault, not a refusal (got ${JSON.stringify(out)} / ${JSON.stringify((thrown as Error)?.message)})`,
      );
    }
  }
}

// ── (n) the resolver's `failed` is live: THIS call's failing resolution does
// make silence a fault. The proof now receives the flag as an argument from its
// own resolution — there is nothing global left to read — so the case arms it
// exactly as a real git would: the injected executor rejects the rev-parse, and
// it is that call's `failed: true` that decides, not any ambient value.
{
  const { exec } = fakeGit([
    { throw: { code: 1, stderr: "fatal: bad revision" } },
    { throw: { code: 1, stderr: "" } },
  ]);
  let thrown: unknown;
  let out: Awaited<ReturnType<typeof proveBaseSha>> | undefined;
  try {
    out = await proveBaseSha(REPO, OID, exec);
  } catch (err) {
    thrown = err;
  }
  assert(
    thrown instanceof Error &&
      /git refused with no reason while a resolution failure was traced/.test(
        (thrown as Error)?.message ?? "",
      ),
    `an empty stderr after this call's own failed resolution is a fault, not a refusal (got ${JSON.stringify(out)} / ${JSON.stringify((thrown as Error)?.message)})`,
  );
}

// ── (o) a NEW run refuses a seed base that is neither "" nor a full sha.
//
// `createRun` trusts its input — `assertRun` is the READ path, and a fresh
// record never passes through it — so before this check a caller that handed
// `runLean` a `main`, a short prefix or a typo'd oid wrote a state file that
// loaded green and anchored every later read to a moving ref. The two refusals
// are the same shape the loader's own validator uses (`LeanStateError`, the
// value clipped), and `""` stays legal: that is the seed that found no mainline.
for (const [label, bad_base] of [
  ["a branch name", "main"],
  ["an 8-hex prefix", OID.slice(0, 8)],
  ["an uppercase full sha", OID.toUpperCase()],
  ["a typo'd oid", `${OID.slice(0, 39)}g`],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = scripted(HAPPY);
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 31, handlers, seed: { baseSha: bad_base } });
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error &&
        /seed baseSha must be empty or a full commit sha/.test(thrown.message) &&
        thrown.message.includes(JSON.stringify(bad_base.slice(0, 80))),
      `a new run refuses ${label} as its seed base (got ${String(thrown)})`,
    );
  } finally {
    cleanup();
  }
}
{
  // …and the two values that ARE legal still start a run.
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = scripted(HAPPY);
    const empty = await runLean({
      repoRoot: dir,
      issue: 32,
      handlers,
      seed: { version: "test", baseSha: "" },
    });
    const full = await runLean({
      repoRoot: dir,
      issue: 33,
      handlers,
      seed: { version: "test", baseSha: OID },
    });
    assert(
      isFullCommitSha(full.run.baseSha) && full.run.baseSha === OID && empty.run.baseSha === "",
      `"" and a full sha both still seed a run (got ${JSON.stringify([empty.run.baseSha, full.run.baseSha])})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
