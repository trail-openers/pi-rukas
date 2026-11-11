#!/usr/bin/env bun
/**
 * #2181 A7/A8 — lean's `land` step, against a REAL repository's base commit.
 *
 * `test-lean-land.ts` injects `checkAuthor`, which is right for the step's own
 * logic and wrong for this question: whether the production seam — the shared gate
 * reading `.pi/merge-authors` at the run's base sha with `git show` — treats an
 * ABSENT gate file as "this repository never opted in" rather than as a refusal.
 * Lean runs in repositories that are not this one (a seeded trial repo carries only
 * the lean config), and an allowlist that opted out by default refused every
 * landing there.
 *
 * So these cases wire the seam the way `land-deps.ts` wires it in production and
 * let real git answer: no file at the base → the merge proceeds; a file that names
 * nobody → refused; a file that lists the author → lands; a file that does not →
 * refused. The forge stays a recorder, because the question is the gate, not the PR.
 */

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import type { HandlerCtx } from "../src/lean/engine.ts";
import type { LandDeps } from "../src/lean/land-deps.ts";
import { landOutcome } from "../src/lean/land.ts";
import { heldForMergeAuthor } from "../src/merge-guard-author.ts";
import type { MergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { GATE_FILE, repoWithOptionalGateFile } from "./lib/author-opt-in-arms.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";
import { LEAN_FIXTURE_AUTHOR } from "./lib/lean-gh-payloads.ts";

const execFileP = promisify(execFile);

/** The same executor shape `land-deps.ts` hands the shared gate in production. */
const execp = async (
  cmd: string,
  opts?: { cwd?: string; argv?: string[]; maxBuffer?: number },
): Promise<{ stdout: string }> => {
  const args = opts?.argv ?? [];
  const { stdout } = await execFileP(cmd, args, {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 64 * 1024,
  });
  return { stdout };
};

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function evidence(over: Partial<MergeEvidence> = {}): MergeEvidence {
  return {
    ok: true,
    failing: [],
    inconclusive: [],
    author: LEAN_FIXTURE_AUTHOR,
    ...over,
  } as MergeEvidence;
}

/**
 * Drive `landOutcome` with the PRODUCTION author gate over a real clone whose
 * gate-file state the case names. `undefined` is the never-opted-in repository.
 */
async function landWithRepo(
  issue: number,
  allowlist: string | undefined,
  opts: { author?: string | null } = {},
) {
  const gate = repoWithOptionalGateFile({ allowlist });
  const f = ciLandLog(issue, {});
  // The run's recorded base must BE the commit the file is (or is not) in, or the
  // case would be judging a list at some commit of the fixture's choosing. The
  // gate takes `repoRoot` and `baseSha` as its own arguments, so the clone that
  // holds the base and the clone the log was built in need not be one repo — what
  // must agree is the sha the run cites and the commit the file is (or is not) in.
  f.ctx.run = { ...f.ctx.run, baseSha: gate.baseSha };
  const calls: unknown[] = [];
  const deps: LandDeps = {
    evidence: async () =>
      evidence(
        opts.author === null
          ? { headOid: f.head, author: undefined }
          : { headOid: f.head, author: opts.author ?? LEAN_FIXTURE_AUTHOR },
      ),
    openPr: async () => 42,
    merge: async (_repo, call) => {
      calls.push(call);
    },
    stateAfter: async () => "MERGED",
    loadConfig: async () => ({ autoMerge: true }),
    checkAuthor: (_repo, sha, author) =>
      heldForMergeAuthor({
        exec: execp,
        cwd: gate.repoRoot,
        baseSha: sha,
        author,
      }),
  };
  const outcome = await landOutcome(f.ctx as HandlerCtx, deps);
  gate.dispose();
  return { outcome, calls, baseSha: gate.baseSha };
}

const ALLOWED_BODY = `# the maintainers\n${LEAN_FIXTURE_AUTHOR}\n`;

{
  // A8 + A7: the repository never committed the gate file. Nothing else changed,
  // so the only thing the cycle lost is a rule it was never granted.
  const r = await landWithRepo(9401, undefined);
  assert(
    r.outcome.kind === "merged" && r.calls.length === 1,
    `A7/A8 lean: a repository with no ${GATE_FILE} at its base lands the PR (${JSON.stringify(r.outcome)})`,
  );
}
{
  // The control that keeps the arm above from being "the gate is off": with the
  // file present, the same author is judged against it.
  const r = await landWithRepo(9402, ALLOWED_BODY);
  assert(
    r.outcome.kind === "merged" && r.calls.length === 1,
    `A8 lean: an allowlisted author lands (${JSON.stringify(r.outcome)})`,
  );
}
{
  const r = await landWithRepo(9403, ALLOWED_BODY, { author: "mallory" });
  assert(
    r.outcome.kind === "refused" && r.calls.length === 0,
    `A8 lean: a stranger is refused and nothing merges (${JSON.stringify(r.outcome)})`,
  );
  assert(
    (r.outcome.kind === "refused" ? (r.outcome.reason ?? "") : "").includes("mallory") &&
      (r.outcome.kind === "refused" ? (r.outcome.reason ?? "") : "").includes(GATE_FILE),
    "…and the refusal names the login and the gate file",
  );
}
{
  const r = await landWithRepo(9404, "# the maintainers\n");
  assert(
    r.outcome.kind === "refused" && r.calls.length === 0,
    `A8 lean: a file that names nobody lands nothing (${JSON.stringify(r.outcome)})`,
  );
  assert(
    (r.outcome.kind === "refused" ? (r.outcome.reason ?? "") : "").includes("names no login"),
    "…and says the gate file names no login",
  );
}
{
  // A7's other half: the author rule is the file's business. With no file, even a
  // PR whose author the forge never reported is not the gate's problem.
  const r = await landWithRepo(9405, undefined, { author: null });
  assert(
    r.outcome.kind === "merged" && r.calls.length === 1,
    `A7 lean: with no gate file, an unreadable author is no reason to refuse (${JSON.stringify(r.outcome)})`,
  );
  const withFile = await landWithRepo(9406, ALLOWED_BODY, { author: null });
  assert(
    withFile.outcome.kind === "refused" && withFile.calls.length === 0,
    `A7 lean: with the file present, the same unreadable author is refused (${JSON.stringify(withFile.outcome)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
