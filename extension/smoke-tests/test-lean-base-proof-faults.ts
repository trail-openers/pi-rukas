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
 *   (l) the swallowed-failure counter is read as a PER-CALL DELTA: an unrelated
 *       earlier rejection elsewhere in the process does not turn this call's
 *       silent refusal into a fault;
 *   (m) the round-2 wordings in both directions: `ambiguous argument` / `unknown
 *       revision` stay refusals, `unable to unpack` / inflate / corrupt / `bad
 *       object` stay faults, and a blob carrying both is a fault;
 *   (n) the counter is live: THIS call's failing resolution does make silence a
 *       fault, which is the other half of the delta rule (l) pins.
 *
 * Everything goes through `lib/lean-base-proof-fixtures.ts`'s stand-in git, and
 * every case asserts on the argv that was asked for.
 */

import { proveBaseSha } from "../src/lean/base-proof.ts";
import { resolveHeadSha, resolveHeadTraceCount } from "../src/review-head-sha.ts";
import {
  enoentGit,
  fakeGit,
  isCatFileProbe,
  killedByTimeout,
  killedGit,
  oddCodeGit,
} from "./lib/lean-base-proof-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

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

// ── (l) the trace counter is read as a PER-CALL DELTA, not absolutely.
//
// `resolveHeadTraceCount` is process-global and never resets, so a probe that
// asked it absolutely would let any unrelated git failure anywhere earlier in the
// process — this suite's own (n), another run's config read — turn a legitimate
// silent refusal into a fault. The counter is armed HERE, by a resolution that
// fails for a reason this proof has nothing to do with, and the proof that runs
// afterwards still refuses: only a failure of ITS OWN resolution is evidence
// about its own base.
{
  const armedBefore = resolveHeadTraceCount();
  const armed = fakeGit([{ throw: { code: 1, stderr: "fatal: bad revision" } }]);
  const unrelated = await resolveHeadSha("/tmp/unrelated-repo", OID, armed.exec);
  assert(
    unrelated === undefined && resolveHeadTraceCount() > armedBefore,
    `the unrelated resolution failed and armed the counter (${armedBefore} → ${resolveHeadTraceCount()})`,
  );
  // Same proof, same empty-stderr refusal, with a traced failure already in the
  // process: it must REFUSE, not throw. Without the per-call baseline this is
  // the case that threw.
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
    `an unrelated traced failure does not turn this call's silence into a fault (${String(thrown)})`,
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

// ── (n) the counter is live: THIS call's failing resolution does make silence a
// fault. The counter is the resolver's own (ungated, unlike the trace write), so
// the case arms it by making the injected executor reject the resolution the way
// a real git would — and it is the DELTA past the baseline `proveBaseSha` took
// that decides, not the absolute value, which is the half (l) pins.
{
  // Armed immediately before the proof, so the value the proof reads as its
  // baseline cannot have moved between the arming and the call.
  const before = resolveHeadTraceCount();
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
    resolveHeadTraceCount() > before,
    `a failing resolution is counted (${before} → ${resolveHeadTraceCount()})`,
  );
  assert(
    thrown instanceof Error &&
      /git refused with no reason while a resolution failure was traced/.test(
        (thrown as Error)?.message ?? "",
      ),
    `an empty stderr after this call's own traced failure is a fault, not a refusal (got ${JSON.stringify(out)} / ${JSON.stringify((thrown as Error)?.message)})`,
  );
}

process.exit(failures());
