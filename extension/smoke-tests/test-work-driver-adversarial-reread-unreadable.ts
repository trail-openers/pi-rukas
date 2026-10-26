/**
 * #1634 — a failed round-2+ diff RE-READ must not end in approval.
 *
 * The round-1 read goes through `readDiffOrFailureOutcome`, which has always
 * refused (ok:false → the no-verdict `diffUnreadable` outcome). The re-read the
 * reviewer loop calls before each later round went through a different door: it
 * threw a plain `Error`, which `work-driver-adversarial-fanout-run.ts` let reach
 * `adversarial.ts`, where the loop caught it, noted the staleness, and reviewed
 * the PREVIOUS round's diff to an `APPROVED` that had no diff behind it. Same
 * gate, same no-signal answer, opposite outcome.
 *
 * The fix is on the caller side: `getDiff` throws `DiffRereadError`, and the
 * pass turns that into the SAME no-verdict outcome a failed round-1 read
 * produces — so the aggregate parks with `adversarial-diff-unreadable` whichever
 * of the two reads broke.
 *
 * The fixtures drive `ctx.adversarialLoopFn`, the driver's own injection seam,
 * and the fake calls the very `getDiff` the production pass hands it. The tree
 * is a REAL repository, so the round-1 read genuinely succeeds — which is what
 * keeps this from being the round-1 case over again — and the re-read is
 * switched off by counting the pass's git invocations: `rev-parse
 * --show-toplevel` appears once per read, so the Nth toplevel probe is the Nth
 * read, and `failFrom` is which read stops answering.
 *
 * #1634 round 2 — the loop itself is now also proved not to swallow the throw
 * (`smoke-tests/test-adversarial-reread-throws.ts` drives the REAL
 * `runAdversarialLoop`). What THIS file pins is the other half: that the driver
 * GATE — `runAdversarial` and its event log — parks with the read's cap when the
 * re-read dies, with no `adversarial-approved` and no empty-diff skip.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/** A real repository with one committed change, so `baseSha..HEAD` is non-empty. */
function dirtyRepo(label: string): { dir: string; baseSha: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-reread-${label}-`));
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, ["add", "a.ts"]);
  const baseSha = git(dir, ["commit", "-q", "-m", "base"]);
  writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
  git(dir, ["add", "b.ts"]);
  git(dir, ["commit", "-q", "-m", "the change under review"]);
  const base = git(dir, ["rev-parse", "HEAD~1"]);
  return { dir, baseSha: base };
}

/** The driver's exec seam, typed once — the shape every fake below must satisfy. */
type VerifyExec = NonNullable<DriverContext["verifyExecFn"]>;

/**
 * A fake exec for the gate's reads. Every git call the read makes carries
 * `--show-toplevel` or `diff --end-of-options`; counting the toplevel probes
 * counts the reads, and the `failFrom`-th one throws the way a real `git diff`
 * throws when the tree disappears under the cycle. Any OTHER git call answers as
 * a clean tree: the pass also asks git for a fix-delta and a few refs around the
 * review, and a fake that threw there would fail the case for the wrong reason.
 *
 * Typed as the seam itself (`DriverContext["verifyExecFn"]`), so the options
 * object the production read passes — `argv`, `cwd`, `timeout`, `maxBuffer` —
 * is checked against the real declaration rather than a hand-narrowed copy of
 * it, and a signature drift fails the type check instead of the case.
 */
function readExec(opts: { failFrom: number }): VerifyExec {
  let toplevels = 0;
  return async (_cmd, o) => {
    const argv = o?.argv ?? [];
    if (argv.includes("--show-toplevel")) {
      toplevels++;
      if (toplevels >= opts.failFrom) throw new Error("simulated re-read failure");
      return { stdout: `${o?.cwd ?? ""}\n` };
    }
    if (argv.includes("rev-parse")) return { stdout: `${o?.cwd ?? ""}\n` };
    return { stdout: "diff --git a/b.ts b/b.ts\n+export const b = 2;\n" };
  };
}

function mkOps(): DispatchResult {
  return {
    role: "ops",
    ok: true,
    text: "pr: 1",
    toolUses: [],
    ms: 5,
    exitCode: 0,
  };
}

function mkResult(): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "VERDICT: APPROVED",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  };
}

function stateFor(dir: string, baseSha: string): WorkState {
  const s = initialState(1640, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial" as const,
      lastCompletedStep: "develop" as const,
      worktrees: { default: dir },
      baseSha,
      branchName: "feature/issue-1640",
    },
  };
}

/**
 * Run the gate with a fake loop that calls the pass's `getDiff` once for each
 * round after the first, the way the real reviewer loop does.
 */
async function gateWithReread(opts: { rounds: number; failFrom: number; label: string }) {
  const { dir, baseSha } = dirtyRepo(opts.label);
  try {
    let reloaded = 0;
    const ctx = {
      host: { sendUserMessage: () => {} },
      repoRoot: dir,
      issue: 1640,
      verifyExecFn: readExec({ failFrom: opts.failFrom }),
      adversarialLoopFn: async (
        params: { getDiff?: () => Promise<string>; diff: string },
        _signal: AbortSignal,
      ) => {
        for (let r = 2; r <= opts.rounds; r++) {
          // The re-read door is the param the production pass is required to
          // hand the loop when it passes a `diff`; `getDiff` is optional on the
          // seam's own type, so the fixture asserts its presence rather than
          // telling the compiler to look away.
          if (!params.getDiff) throw new Error("the pass handed the loop no getDiff");
          const fresh = await params.getDiff();
          reloaded++;
          void fresh;
        }
        return mkResult();
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkOps();
        if (spec.role === "ops") return mkOps();
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
    } as unknown as DriverContext;
    const after = await runAdversarial(ctx, stateFor(dir, baseSha), Date.now());
    return { events: after.eventLog, reloaded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const approveKinds = ["adversarial-approved", "adversarial-skipped-empty-diff"] as const;

{
  // The control: every read answers, round 2 re-reads, and the gate approves
  // normally. Without this the failing case could pass on a fixture that never
  // reached the re-read at all.
  const { events, reloaded } = await gateWithReread({
    rounds: 2,
    failFrom: 99,
    label: "control",
  });
  assert(reloaded === 1, `control: the round-2 re-read ran (got ${reloaded})`);
  assert(
    events.some((e) => e.kind === "adversarial-approved"),
    "control: a healthy re-read still reaches the ordinary approval",
  );
  assert(
    !events.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable"),
    "control: no read cap on a tree that answers every read",
  );
}

{
  // Round 1 reads fine (read #1); round 2's re-read (read #2) fails. The gate
  // must park with the read's cap and never record an approval.
  const { events, reloaded } = await gateWithReread({
    rounds: 2,
    failFrom: 2,
    label: "round2",
  });
  assert(reloaded === 0, `failed round-2 re-read: the loop never got a diff (got ${reloaded})`);
  assert(
    !events.some((e) => (approveKinds as readonly string[]).includes(e.kind)),
    "failed round-2 re-read → NO approval and NO empty-diff skip",
  );
  assert(
    events.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable"),
    "failed round-2 re-read → parks with `adversarial-diff-unreadable`",
  );
  assert(
    !events.some((e) => e.kind === "adversarial-approved"),
    "failed round-2 re-read → no approval event at all",
  );
  const cap = events.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && (cap.evidence ?? "").includes("could not read the diff"),
    `failed round-2 re-read → the cap names the read in its evidence (got ${cap?.kind === "cap-hit" ? String(cap.evidence).slice(0, 60) : "no cap-hit"})`,
  );
  const failed = events.find((e) => e.kind === "dispatch-failed");
  assert(
    failed?.kind === "dispatch-failed" && failed.diffUnreadable === true,
    "failed round-2 re-read → the synthetic event carries the structural marker",
  );
}

{
  // Rounds 2 and 3 read fine, round 4's does not: the rule is about the read,
  // not about which round met it.
  const { events } = await gateWithReread({ rounds: 4, failFrom: 4, label: "round4" });
  assert(
    !events.some((e) => (approveKinds as readonly string[]).includes(e.kind)),
    "failed round-4 re-read → NO approval",
  );
  assert(
    events.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable"),
    "failed round-4 re-read → parks with the same cap",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
