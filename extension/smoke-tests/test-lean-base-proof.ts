#!/usr/bin/env bun
/**
 * lean/base-proof — the two rules a base must satisfy, and the second opinion
 * that decides whether a git miss is a refusal or an infrastructure fault.
 *
 * The base is the ref every later read of a lean run is anchored to, so the
 * proof is the one gate that decides whether "the run's base" means anything.
 * These cases own the halves that a real repository cannot be bent into:
 *
 *   (a) a value that is not an oid is refused by the SHAPE rule and asks git
 *       nothing at all — a moving ref must never reach the command line;
 *   (b) a full sha the clone does not hold is refused by the RESOLUTION rule,
 *       after both git reads, both bounded;
 *   (c) a full sha that resolves to a DIFFERENT oid is refused with what it
 *       resolved to — the equality half, which a peel alone would wave through;
 *   (d) a value that resolves back to itself is `ok`, and asks nothing more;
 *   (e) a git that could not answer THROWS. This is the case the whole module
 *       exists for: the first probe's `undefined` means "not a commit" and
 *       "git broke" at once, and answering the second one with the first one's
 *       verdict posts "your base is not a commit" on an issue whose clone
 *       merely has a locked index;
 *   (f) the exit codes/wordings that DO count as "no such object" — 128 with
 *       git's `Not a valid object name`, 1 with an empty stderr — are refusals,
 *       not faults. The boundary is drawn once, here.
 *
 * Everything goes through `lib/lean-base-proof-fixtures.ts`'s stand-in git, and
 * every case asserts on the argv that was asked for: a proof that skipped the
 * peel, ran it before the resolution, or left it unbounded is a failure these
 * cases can see.
 */

import { proveBaseSha } from "../src/lean/base-proof.ts";
import {
  GIT_TIMEOUT,
  fakeGit,
  gitFault,
  isCatFileProbe,
  isRevParse,
  missingObject,
} from "./lib/lean-base-proof-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const OID = "0123456789abcdef0123456789abcdef01234567";
const REPO = "/tmp/not-a-real-repo";

// ── (a) shape first, and git is never asked.
for (const [label, value] of [
  ["a branch name", "main"],
  ["HEAD", "HEAD"],
  ["a suffix chain", "main^{commit}`touch x`@{0}"],
  ["an 8-hex prefix", OID.slice(0, 8)],
  ["an uppercase full sha", OID.toUpperCase()],
] as const) {
  const { exec, calls } = fakeGit([]);
  const out = await proveBaseSha(REPO, value, exec);
  assert(
    out.ok === false && out.rule === `base sha ${value} is not a full commit sha`,
    `${label} is refused by the shape rule (got ${JSON.stringify(out)})`,
  );
  assert(
    calls.length === 0,
    `${label} never reaches git — a moving ref must not become an argument (asked ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (b) an oid the clone does not hold: both reads, both bounded.
{
  const { exec, calls } = fakeGit([missingObject(OID), missingObject(OID)]);
  const out = await proveBaseSha(REPO, OID, exec);
  assert(
    out.ok === false && out.rule === `base sha ${OID} is not a commit in this clone`,
    `an absent oid is refused by the resolution rule (got ${JSON.stringify(out)})`,
  );
  assert(
    calls.length === 2,
    `both git reads ran (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
  assert(
    calls[0] !== undefined && isRevParse(calls[0].argv),
    `the first read is the resolution (got ${JSON.stringify(calls[0]?.argv)})`,
  );
  assert(
    calls[1] !== undefined && isCatFileProbe(calls[1].argv),
    `the second read is the peel (got ${JSON.stringify(calls[1]?.argv)})`,
  );
  assert(
    calls.every((c) => c.timeout === GIT_TIMEOUT),
    `every git read carries the same bound the canonical resolver uses (got ${JSON.stringify(calls.map((c) => c.timeout))})`,
  );
  assert(
    calls.every((c) => c.cwd === REPO),
    "every git read runs in the run's repoRoot, not the process cwd",
  );
}

// ── (c) resolves, but to something else.
{
  const other = "ffffffffffffffffffffffffffffffffffffffff";
  const { exec, calls } = fakeGit([
    { stdout: `${other}\n` },
    { stdout: `${other}\n` },
    { stdout: "" },
  ]);
  const out = await proveBaseSha(REPO, OID, exec);
  assert(
    out.ok === false &&
      out.rule === `base sha ${OID} is not a commit in this clone (it resolves to ${other})`,
    `a base that resolves elsewhere says what it resolved to (got ${JSON.stringify(out)})`,
  );
  assert(
    calls.length === 1,
    `a successful resolution needs no second opinion (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (d) the happy path asks for nothing more than the resolution.
{
  const { exec, calls } = fakeGit([{ stdout: `${OID}\n` }]);
  const out = await proveBaseSha(REPO, OID, exec);
  assert(
    out.ok === true,
    `a full sha that resolves to itself is the base (got ${JSON.stringify(out)})`,
  );
  assert(
    calls.length === 1 && isRevParse(calls[0]?.argv ?? []),
    `the proof is one bounded resolution and nothing else (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (e) a git that could not answer is a fault, and a fault THROWS.
for (const [label, fault] of [
  ["a repo git could not read at all", gitFault()],
  [
    "an unexpected exit code",
    { throw: { code: 1, stderr: "fatal: internal error: object store corrupt\n" } },
  ],
  [
    "a signalled git",
    { throw: { code: null, stderr: "", message: "Command failed: git", killed: true } },
  ],
] as const) {
  const { exec, calls } = fakeGit([missingObject(OID), fault]);
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
  assert(
    /^could not verify base sha 0123456789abcdef0123456789abcdef01234567: /.test(
      (thrown as Error)?.message ?? "",
    ),
    `the throw names the base and the cause (got ${JSON.stringify((thrown as Error)?.message)})`,
  );
  assert(
    (thrown as Error)?.message.length !== undefined &&
      (thrown as Error).message.length < "could not verify base sha ".length + 81 + 2 + 161,
    `the throw stays inside its clips (len ${(thrown as Error)?.message.length})`,
  );
  assert(
    (thrown as Error)?.name === "Error",
    `the fault is a plain Error, not a typed state error (got name ${JSON.stringify((thrown as Error)?.name)})`,
  );
  assert(
    calls.length === 2 && isCatFileProbe(calls[1]?.argv ?? []),
    `the second opinion ran before the throw for ${label} (got ${JSON.stringify(calls.map((c) => c.argv))})`,
  );
}

// ── (f) the wordings that DO mean "no such object" are refusals, not faults.
for (const [label, reply] of [
  [
    "exit 1 with git's missing-object wording",
    {
      throw: {
        code: 1,
        stderr: "fatal: missing object 1111111111111111111111111111111111111111\n",
      },
    },
  ],
  ["exit 1 with an empty stderr", { throw: { code: 1, stderr: "" } }],
  ["exit 128 with an empty stderr", { throw: { code: 128, stderr: "" } }],
] as const) {
  const { exec } = fakeGit([missingObject(OID), reply]);
  const out = await proveBaseSha(REPO, OID, exec);
  assert(
    out.ok === false && out.rule === `base sha ${OID} is not a commit in this clone`,
    `${label} is a refusal, not a fault (got ${JSON.stringify(out)})`,
  );
}

process.exit(failures());
