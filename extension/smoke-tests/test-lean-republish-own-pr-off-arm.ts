#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR=0` is the operator's escape hatch, and the promise
 * an escape hatch makes is that the arm it restores is the arm that shipped.
 *
 * `pushLeaseTarget` is the site. Its pre-fix body was, in full:
 *
 *     const remote = (await remoteBranchSha(deps, wt, branch)) ?? "";
 *     if (remote === "" || remote === head) return remote;
 *     const blocking = (await listOpenPrs(f, branch)).find((pr) => !isSettled(pr.state));
 *     if (blocking !== undefined)
 *       throw new PublishInfraError(
 *         `refusing to rewrite ${branch}: the forge returned an unsettled PR row (${blocking.url || "(no URL returned)"})`,
 *       );
 *     return remote;
 *
 * With `"0"` the step must make exactly those calls and no others on the shape the
 * exemption would have taken: origin read once by ls-remote, `prList` asked once, the
 * refusal raised with that message, NO `merge-base --is-ancestor` probe (the pre-fix
 * code never asked git about ancestry), no push, no PR write. The golden is spelled out
 * here as a literal because that is what makes the case red on a bad switch rather than
 * self-confirming: a fixture that computed the expected calls from the code under test
 * would compare the code with itself.
 *
 * The on-arm behaviour itself — what the exemption admits and refuses — is
 * `test-lean-publish-republish-own-pr.ts`; the truth table and both docs rows are
 * `test-lean-republish-own-pr-switch.ts`.
 */

import { rmSync } from "node:fs";
import { PublishInfraError } from "../src/lean/publish-deps.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";
import { fakePr } from "./lib/lean-publish-forge.ts";
import { republishRecorder } from "./lib/lean-republish-recording-exec.ts";

const { assert, failures } = makeAssert();
const SELF = "test-lean-republish-own-pr-off-arm.ts";
const check = (cond: boolean, msg: string): void => assert(cond, `${SELF}: ${msg}`);

const OWN_URL = "https://forge.example/pull/55";
/** The `-c` flags every lean git call carries, spelled as the call site spells them. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * What the off arm must leave behind on the shape the exemption would have taken:
 * the ONE origin read `pushLeaseTarget` makes, and no lease at all — the pre-fix body
 * returns the refusal from the forge list without ever rendering a push. The step's
 * earlier reads (the guard's mainline probes, `assertTree`'s three) are `publish-deps`'
 * contract and its own suite pins them, so the case compares this tail and nothing
 * before it.
 */
function expectedTail(branch: string): string[] {
  return [[...NO_HOOKS, "ls-remote", "--heads", "origin", `refs/heads/${branch}`].join(" ")];
}

/** Drive one republish case with the switch pinned to `value`, recording every call. */
async function drive(value: "0" | "1", issue: number) {
  const rec = republishRecorder();
  let out: Awaited<ReturnType<typeof runPublish>> | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR: value }, async () => {
    out = await runPublish({
      issue,
      verify: { kind: "green" },
      originStale: "own-publish",
      priorPublish: { prUrl: OWN_URL },
      openPrs: [fakePr(55, OWN_URL, `lean/issue-${issue}`)],
      execRecorder: rec,
    });
  });
  if (out === undefined) throw new Error("the drive produced no result");
  return { r: out, rec };
}

// ------------------------------ the off arm: today's refusal, and nothing else
{
  const issue = 920;
  const { r, rec } = await drive("0", issue);
  const branch = r.branch;
  check(
    r.threw instanceof PublishInfraError && /refusing to rewrite/.test(r.threw.message),
    `(off) the run's own PR refuses, as it did before the exemption (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  check(
    r.threw?.message ===
      `refusing to rewrite ${branch}: the forge returned an unsettled PR row (${OWN_URL})`,
    `(off) the refusal text is the pre-fix message, byte for byte (got ${JSON.stringify(r.threw?.message)})`,
  );

  const gitCalls = rec.execCalls
    .filter((c) => c.cmd === "git")
    .map((c) => (c.argv ?? []).join(" "));
  const want = expectedTail(branch);
  const tail = gitCalls.slice(gitCalls.length - want.length);
  check(
    JSON.stringify(tail) === JSON.stringify(want),
    `(off) the step's own git calls are the transcription — one read, then stop (${JSON.stringify(tail)})`,
  );
  check(
    r.leaseArg === undefined,
    `(off) no push was ever rendered — the pre-fix body refuses before the lease (${JSON.stringify(r.leaseArg)})`,
  );
  check(
    rec.ancestryCalls().length === 0,
    `(off) no ancestry probe is made — the pre-fix check never asked git (${String(rec.ancestryCalls().length)})`,
  );
  check(rec.pushCall() === undefined, "(off) the refused push never happened");
  check(
    JSON.stringify(rec.forgeCalls) ===
      JSON.stringify([{ call: "prList", detail: `open/${branch}` }]),
    `(off) the forge call sequence is today's: one prList, nothing after (${JSON.stringify(rec.forgeCalls)})`,
  );
  check(r.forge.prCreateCalls.length === 0, "(off) a refused push opens no PR");
}

// ------------- the on arm of the SAME drive: the exemption adds the probe and pushes
{
  const issue = 921;
  const { r, rec } = await drive("1", issue);
  const branch = r.branch;
  check(
    r.outcome?.kind === "ok",
    `(on) the same drive publishes (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  const ancestry = rec.ancestryCalls();
  check(ancestry.length === 1, `(on) exactly one ancestry probe (${String(ancestry.length)})`);
  check(
    ancestry[0]?.argv?.join(" ") ===
      [...NO_HOOKS, "merge-base", "--is-ancestor", r.priorHead ?? "", r.head].join(" "),
    `(on) the probe compares origin's recorded sha against the head (${JSON.stringify(ancestry[0]?.argv)})`,
  );
  check(
    ancestry[0]?.cwd === r.wt && ancestry[0]?.timeout === 30_000,
    `(on) the probe runs in the run's worktree under a bound (${JSON.stringify([ancestry[0]?.cwd, ancestry[0]?.timeout])})`,
  );
  check(
    rec.pushCall()?.argv?.includes(`--force-with-lease=refs/heads/${branch}:${r.priorHead}`) ===
      true,
    `(on) the push is leased to the sha read before the forge check (${JSON.stringify(rec.pushCall()?.argv)})`,
  );
  check(
    JSON.stringify(rec.forgeCalls) ===
      JSON.stringify([
        { call: "prList", detail: `open/${branch}` },
        { call: "prList", detail: `open/${branch}` },
        { call: "prView", detail: "55" },
      ]),
    `(on) the forge sequence is the lease check's list, openPr's reuse list, then the draft read (${JSON.stringify(rec.forgeCalls)})`,
  );
}

if (failures() === 0) console.log("\nlean republish own-PR, off arm: all assertions passed");
for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a temp dir the OS reaps anyway is not a failing assertion.
  }
}
process.exit(failures());
