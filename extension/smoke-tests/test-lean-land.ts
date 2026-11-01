#!/usr/bin/env bun
/**
 * lean/land — the merge happens on evidence, or it does not happen.
 *
 * The machine already forbids arriving here without a green `ci`, and the
 * engine's arrival gate (`landEarned`) re-checks the newest decided
 * `verify`/`ci`. Neither is restated in `land.ts` and neither is restated here —
 * `test-lean-machine*.ts` and `test-lean-engine-land-gate.ts` own them, and a
 * second copy of that judgement is the bloat this step exists to avoid.
 *
 * What this file pins is the two things only `land` observes — the config grant
 * and the head equality — plus the rule that `merged` is a claim about the forge,
 * read back, never about the merge call returning.
 *
 *   (a) granted + evidence ok + head matches + read back MERGED -> merged,
 *       and the merge was pinned to the verified head
 *   (b) autoMerge false -> refused, no merge attempted
 *   (c) config unreadable -> refused, no merge attempted
 *   (d) no open PR on the branch -> refused
 *   (e) evidence not ok -> refused carrying the forge's own reason
 *   (f) a required check skipped/neutral -> refused (green to GitHub, not to us)
 *   (g) the forge gave no full head OID -> refused; an unpinned merge never runs
 *   (h) the PR head is not the verified head -> refused naming both
 *   (i) the merge call throws -> refused, never a `merged`
 *   (j) the merge returned but the PR is not MERGED -> refused
 *   (k) no verified head on the log -> refused before the forge is touched
 *
 * The log is real (`lib/lean-ci-land-fixture`): the verified head is the oid of
 * a commit that exists, so `merged` is never asserted over a record the loader
 * would refuse. The forge itself is a recorder — offline, no PR, no merge.
 */

import { rmSync } from "node:fs";
import type { HandlerCtx } from "../src/lean/engine.ts";
import { landOutcome } from "../src/lean/land.ts";
import type { LandDeps, MergeCall } from "../src/lean/land-deps.ts";
import type { MergeEvidence } from "../src/work-driver-merge-evidence.ts";
import type { Outcome } from "../src/lean/state.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function evidence(over: Partial<MergeEvidence> = {}): MergeEvidence {
  return { ok: true, failing: [], inconclusive: [], ...over };
}

interface LandCase {
  autoMerge?: boolean;
  configFails?: boolean;
  /** The number the forge reports for the branch; omit for the default PR. */
  prNumber?: number;
  /** The branch has no open PR at all. */
  noPr?: boolean;
  ev?: MergeEvidence | undefined;
  /** What `stateAfter` reports once the merge has run. */
  after?: string;
  /** Reject the merge call. */
  mergeThrows?: boolean;
  noVerifiedHead?: boolean;
  verifiedHead?: string;
}

/** Run `land` on a real verified log with the forge replaced by a recorder. */
async function run(c: LandCase): Promise<{ outcome?: Outcome; calls: MergeCall[]; head: string }> {
  const f = ciLandLog(9, {
    ...(c.noVerifiedHead === true ? { noVerifiedHead: true } : {}),
    ...(c.verifiedHead === undefined ? {} : { verifiedHead: c.verifiedHead }),
  });
  const head = c.verifiedHead ?? f.head;
  const calls: MergeCall[] = [];
  const deps: LandDeps = {
    evidence: async () =>
      c.ev === undefined ? evidence({ headOid: head, mergeStateStatus: "CLEAN" }) : c.ev,
    openPr: async () => (c.noPr === true ? undefined : (c.prNumber ?? 42)),
    merge: async (_repo, call) => {
      calls.push(call);
      if (c.mergeThrows === true) throw new Error("branch protection refused it");
    },
    stateAfter: async () => (c.after === undefined ? "MERGED" : c.after),
    loadConfig: async () => {
      if (c.configFails === true) throw new Error("git show .pi/work.json: unable to read");
      return { autoMerge: c.autoMerge !== false };
    },
  };
  return { outcome: await landOutcome(f.ctx as HandlerCtx, deps), calls, head };
}

// ── (a) everything observed -> merged, and the merge carried the pin ──────
{
  const r = await run({});
  assert(r.outcome?.kind === "merged", `(a) granted, ok, head matches -> merged (${JSON.stringify(r.outcome)})`);
  assert(r.calls.length === 1, "(a) exactly one merge was attempted");
  assert(r.calls[0]?.headOid === r.head, "(a) pinned to the verified head");
  assert(r.calls[0]?.method === "squash", "(a) as a squash");
  assert(r.calls[0]?.number === 42, "(a) on the PR the branch actually carries");
}

// ── (b) no grant -> refused, forge untouched ─────────────────────────────
{
  const r = await run({ autoMerge: false });
  assert(r.outcome?.kind === "refused", `(b) autoMerge false -> refused (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("autoMerge"), "(b) the refusal names the missing grant");
  assert(r.calls.length === 0, "(b) no merge was attempted");
}

// ── (c) an unreadable config is a refusal, not a silent default ──────────
{
  const r = await run({ configFails: true });
  assert(r.outcome?.kind === "refused", `(c) unreadable config -> refused (${JSON.stringify(r.outcome)})`);
  assert(
    (r.outcome?.reason ?? "").includes("could not be read"),
    `(c) and it says the config could not be read (${r.outcome?.reason})`,
  );
  assert(r.calls.length === 0, "(c) no merge was attempted");
}

// ── (d) nothing open on the branch ──────────────────────────────────────
{
  const r = await run({ noPr: true });
  assert(r.outcome?.kind === "refused", `(d) no open PR -> refused (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("no open PR"), "(d) naming the branch it looked on");
  assert(r.calls.length === 0, "(d) no merge was attempted");
}

// ── (e) the forge says it is not mergeable ──────────────────────────────
{
  const r = await run({ ev: { ok: false, reason: "the base moved", failing: [], inconclusive: [] } });
  assert(r.outcome?.kind === "refused", `(e) evidence not ok -> refused (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("the base moved"), "(e) and carries the forge's own reason");
  assert(r.calls.length === 0, "(e) no merge was attempted");
}

// ── (f) skipped/neutral required checks are not green ───────────────────
{
  const r = await run({ ev: evidence({ headOid: undefined, inconclusive: ["build"] }) });
  assert(r.outcome?.kind === "refused", `(f) a skipped required check -> refused (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("build"), "(f) naming the inconclusive check");
  assert(r.calls.length === 0, "(f) no merge was attempted");
}

// ── (g) no head to pin -> refuse rather than merge unpinned ─────────────
{
  const r = await run({ ev: evidence({ headOid: undefined, headOidError: "the read returned nothing" }) });
  assert(r.outcome?.kind === "refused", `(g) no head OID -> refused (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("no full head OID"), "(g) naming the missing pin");
  assert(r.calls.length === 0, "(g) an unpinned merge is never attempted");
}

// ── (h) the PR moved off the verified head ──────────────────────────────
{
  const r = await run({ ev: evidence({ headOid: "c".repeat(40), mergeStateStatus: "CLEAN" }) });
  assert(r.outcome?.kind === "refused", `(h) a moved head -> refused (${JSON.stringify(r.outcome)})`);
  assert(
    (r.outcome?.reason ?? "").includes("is not the verified head"),
    `(h) naming both heads (${r.outcome?.reason})`,
  );
  assert(r.calls.length === 0, "(h) no merge was attempted");
}

// ── (i) the forge refuses the merge ─────────────────────────────────────
{
  const r = await run({ mergeThrows: true });
  assert(r.outcome?.kind === "refused", `(i) a throwing merge -> refused, not merged (${JSON.stringify(r.outcome)})`);
  assert(r.calls.length === 1, "(i) the merge was attempted exactly once");
}

// ── (j) the call returned but the PR did not merge ──────────────────────
{
  const r = await run({ after: "OPEN" });
  assert(r.outcome?.kind === "refused", `(j) a merge that did not merge -> refused (${JSON.stringify(r.outcome)})`);
  assert(
    (r.outcome?.reason ?? "").includes("not MERGED"),
    `(j) because it was read back and did not say MERGED (${r.outcome?.reason})`,
  );
}

// ── (k) nothing verified -> refused before the forge is reached ─────────
{
  const r = await run({ noVerifiedHead: true });
  assert(r.outcome?.kind === "refused", `(k) no verified head -> refused (${JSON.stringify(r.outcome)})`);
  assert(r.calls.length === 0, "(k) no merge was attempted");
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
