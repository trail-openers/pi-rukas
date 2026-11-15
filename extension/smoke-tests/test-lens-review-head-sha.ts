#!/usr/bin/env bun
/**
 * #1039 (as split for #2261) — the ONE head identity a lens round writes to the
 * ledger, plus the type that keeps that rule honest.
 *
 * `lens-review-head-sha.ts` was extracted from an inline block in
 * `lens-review.ts`, and the first cut took a structural stand-in for its
 * argument (`kind: string`) instead of the real `ReviewDiffOutcome` union. The
 * behaviour was identical on every shape the code could produce, so no
 * behavioural test could see the loss: inline, the block had discriminated on a
 * UNION, where a new `ok` variant carrying its head outside `delta` is a compile
 * error; extracted, it compared a plain string and would have silently resolved
 * `headRef ?? "HEAD"` — a wrong-but-plausible head in the ledger, which is the
 * defect class #1039 closed.
 *
 * So this file pins both halves: the behaviour, for every kind the layer can
 * produce, and the TYPE — by handing `tsc` a call the widened parameter accepted
 * and the union must reject. A parameter widened back to a look-alike breaks the
 * build and this suite, not a comment nobody re-reads.
 */

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRoundHeadSha } from "../src/lens-review-head-sha.ts";
import type { ReviewDiffOutcome } from "../src/lens-review-diff.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const EXT = path.join(import.meta.dirname, "..");
const BAD_BASE = "tmp-head-sha-bad-call.ts";
const BAD_CALL = path.join(EXT, "src", BAD_BASE);
const TSC = path.join(EXT, "node_modules", "typescript", "bin", "tsc");
const TSCONFIG = path.join(EXT, "tsconfig.json");

/** The exec seam, answering whatever `rev-parse` would answer for a real repo. */
function execReturning(out: string): VerifyExecFn {
  return (async () => ({ stdout: out, stderr: "" })) as VerifyExecFn;
}

// ── the union is the parameter type, not a look-alike ───────────────────────
// These four assignments are compile-time assertions: each must be a legal
// `ReviewDiffOutcome`, and `tsc -p tsconfig.smoke-tests.json` says so.
const okFull: ReviewDiffOutcome = { kind: "ok", diff: "d", diffSource: "computed" };
const okDelta: ReviewDiffOutcome = {
  kind: "ok",
  diff: "d",
  diffSource: "computed",
  delta: { since: SHA_B, head: SHA_A },
};
const blocked: ReviewDiffOutcome = { kind: "blocked", problem: "unreadable" };
const noReview: ReviewDiffOutcome = { kind: "noReview", since: SHA_B, head: SHA_A, reason: "r" };

{
  // The runtime half of the same property: a call whose `kind` is not one of the
  // outcome's variants must be a compile error. Written into src/ so the real
  // tsconfig typechecks it, compiled, then removed. While the parameter was
  // `kind: string` this compiled clean — which is exactly what this pins out.
  const source = [
    'import { resolveRoundHeadSha } from "./lens-review-head-sha.ts";',
    'const exec = (async () => ({ stdout: "", stderr: "" })) as never;',
    'export const bad = resolveRoundHeadSha(',
    '  { kind: "pending-rebase" },',
    '  "/repo",',
    '  undefined,',
    "  exec,",
    ");",
    "",
  ].join("\n");
  writeFileSync(BAD_CALL, source);
  let diagnostics = "";
  let compiled = true;
  try {
    execFileSync(process.execPath, [TSC, "--noEmit", "-p", TSCONFIG], {
      cwd: EXT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    compiled = false;
    diagnostics = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
  } finally {
    rmSync(BAD_CALL, { force: true });
  }
  const line = diagnostics.split("\n").find((l) => l.includes(BAD_BASE)) ?? "";
  assert(
    !compiled && /TS\d{4}/.test(diagnostics) && line !== "",
    `a non-outcome \`kind\` is a compile error against the head resolver — a widened \`kind: string\` would compile it (tsc: ${line.slice(0, 120) || "no diagnostic"})`,
  );
}

// ── behaviour on every kind the layer can produce ───────────────────────────
{
  const got = await resolveRoundHeadSha(okDelta, "/repo", undefined, execReturning(`${SHA_A}\n`));
  assert(got === SHA_A, `ok + a delta whose head is already a SHA returns it (${String(got)})`);
}

{
  const got = await resolveRoundHeadSha(
    { ...okDelta, delta: { since: SHA_B, head: "feature/not-a-sha" } } as ReviewDiffOutcome,
    "/repo",
    undefined,
    execReturning(`${SHA_A}\n`),
  );
  assert(
    got === undefined,
    "ok + a delta whose head is a raw ref resolves NOTHING (a raw ref must never reach the ledger)",
  );
}

{
  const got = await resolveRoundHeadSha(okFull, "/repo", "origin/feature", execReturning(`${SHA_A}\n`));
  assert(got === SHA_A, `ok without a delta goes through the shared resolver (${String(got)})`);
}

for (const [name, outcome] of [
  ["blocked", blocked],
  ["noReview", noReview],
  [
    "carry",
    {
      kind: "carry",
      from: SHA_B,
      head: SHA_A,
      prev: SHA_B,
      verdict: "APPROVED",
      written: Promise.resolve(undefined),
    } as ReviewDiffOutcome,
  ],
] as const) {
  const got = await resolveRoundHeadSha(outcome, "/repo", "origin/feature", execReturning(`${SHA_A}\n`));
  assert(got === undefined, `${name}: no head to name, so the field is absent (${String(got)})`);
}

{
  // An empty resolver answer leaves the field absent rather than writing the ref.
  const got = await resolveRoundHeadSha(okFull, "/repo", undefined, execReturning("  \n"));
  assert(got === undefined, `an unresolvable HEAD resolves to nothing (${String(got)})`);
}

{
  // A git that throws is the same answer: absent, never the caller's ref string.
  const throwing = (async () => {
    throw new Error("git: rev-parse failed");
  }) as unknown as VerifyExecFn;
  const got = await resolveRoundHeadSha(okFull, "/repo", undefined, throwing);
  assert(got === undefined, `a git that throws resolves to nothing (${String(got)})`);
}

console.log(`\nhead-sha ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
