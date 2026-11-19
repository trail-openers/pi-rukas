/**
 * work-driver-issue-spec — the approved spec a host hands a classic `/work`
 * cycle (`issue-spec.ts`), and the `tehas:spec v1` block its PR body carries.
 *
 * Explore reads the spec once, into the issue-body artifact every later reader
 * (plan, develop, lens, lens-fix, adversarial) already reads: one seam, so no
 * reader can see the issue without the spec. An entry that does not verify
 * stops the cycle before any fetch or dispatch, and the bare issue body is
 * never used in its place.
 *
 * The block is computed once per cycle at commit-pr entry and cached on state:
 * a host compares only the manifest's sha256, so the requirement lines need not
 * follow later fixes. Every driver body write ends with that cached block and
 * is checked with `specBlockProblem` before it is sent. An LLM-written body is
 * never trusted to carry it: after every commit-pr outcome the PR body is read
 * back and repaired, and a body that cannot be repaired halts the cycle.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { APPROVED_TAIL_CHARS } from "./adversarial-prompts.ts";
import { execp } from "./exec.ts";
import { renderSpecBlock, specBlockProblem, withoutSpecBlocks } from "./issue-spec-block.ts";
import { specCheckLines } from "./issue-spec-check.ts";
import {
  APPROVED_SPEC_MARKER,
  type IssueSpec,
  loadIssueSpec,
  withApprovedSpec,
} from "./issue-spec.ts";
import { driverPublicTextCheck } from "./public-hygiene-driver.ts";
import { normaliseDriverPublishPaths } from "./public-hygiene-normalise.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { cycleDispatch } from "./work-driver-cycle-entry.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { lensWorktree } from "./work-driver-lens-fix-records.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

export type DisclosureResult = { ok: true } | { ok: false; reason: string };
type Fetch = (issue: number, cwd: string) => Promise<{ stdout: string }>;

/** Every issue's spec, or why one of them is not the approved spec. */
export async function cycleSpecs(
  issues: number[],
): Promise<{ specs: Map<number, IssueSpec> } | { why: string }> {
  const specs = new Map<number, IssueSpec>();
  for (const n of issues) {
    const r = await loadIssueSpec(n);
    if (r.kind === "invalid") return { why: `approved spec ${r.why}` };
    if (r.kind === "ok") specs.set(n, r.spec);
  }
  return { specs };
}

/**
 * The issue-body fetch with each issue's spec appended. The approved title and
 * body replace the forge read when the host handed them. Never throws a spec
 * error: the fetch retry would retry it and report it as a forge rejection.
 */
export function specFetcher(live: Fetch, specs: Map<number, IssueSpec>): Fetch {
  return async (issue, cwd) => {
    const spec = specs.get(issue);
    if (spec === undefined) return live(issue, cwd);
    const stdout = spec.approved
      ? `${spec.approved.title}\n\n${spec.approved.body}`
      : (await live(issue, cwd)).stdout;
    return { stdout: withApprovedSpec(stdout, spec) };
  };
}

/** `body` for an inline prompt: the prose is cut at `cap`, an appended spec is kept whole. */
export function inlineBody(body: string, cap: number): { text: string; truncated: boolean } {
  const at = body.lastIndexOf(APPROVED_SPEC_MARKER);
  const prose = at < 0 ? body : body.slice(0, at);
  const tail = at < 0 ? "" : body.slice(at, at + APPROVED_TAIL_CHARS);
  return { text: prose.slice(0, cap) + tail, truncated: prose.length > cap };
}

/** `body` with its spec blocks replaced by `block`, appended last; unchanged when there is no block. */
export function specBlocked(body: string, block: string | undefined): string {
  return block === undefined ? body : `${withoutSpecBlocks(body).trimEnd()}\n\n${block}`;
}

/**
 * The one in-process PR body write: public-text checked, then, when the cycle
 * has a block, `specBlockProblem` on the checked bytes, then `gh pr edit`.
 * Callers compose with `specBlocked`; this refuses any body that does not carry the cycle's block.
 */
export async function writePrBody(
  ctx: CycleContext,
  state: WorkState,
  execFn: VerifyExecFn,
  prNumber: number,
  composed: string,
  tag: string,
): Promise<DisclosureResult> {
  const block = state.pipelineState.specBlock;
  // A public publish the tool_call guard cannot see: the bytes sent are the bytes judged.
  const checked = await driverPublicTextCheck(
    "pull request body",
    composed,
    "gh pr edit",
    ctx.repoRoot,
    { exec: execFn, repoRoot: ctx.repoRoot },
  );
  if (checked.refusal !== undefined) {
    trace(`work-driver: PR body not written: ${checked.refusal.slice(0, 160)}`);
    return { ok: false, reason: checked.refusal };
  }
  const problem =
    block === undefined
      ? undefined
      : (specBlockProblem(checked.text) ??
        (checked.text.includes(block) ? undefined : "it is not the cycle's block"));
  if (problem !== undefined)
    return { ok: false, reason: `the PR body's spec block is unreadable: ${problem}` };
  const dir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  await fs.mkdir(dir, { recursive: true });
  const bodyFile = path.join(dir, `pr-body-${tag}-${prNumber}.md`);
  await fs.writeFile(bodyFile, checked.text, "utf8");
  await execFn("gh", {
    argv: ["pr", "edit", String(prNumber), "--body-file", bodyFile],
    cwd: ctx.repoRoot,
  });
  return { ok: true };
}

const specHalt = (state: WorkState, evidence: string): WorkState =>
  appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "step-failed:commit-pr",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
  });

/**
 * At commit-pr entry: the cycle's block, computed by one check child unless a
 * block for the manifest's sha256 is already cached. The child reads the
 * develop tree the reviewers read, uncommitted files included, because the
 * integrated head does not exist yet. A spec that no longer verifies, or is
 * not the one explore read, halts: the block never pins a spec the cycle was
 * not built against.
 */
export async function specBlockReady(
  ctx: CycleContext,
  state: WorkState,
): Promise<{ state: WorkState; halted?: true }> {
  const r = await loadIssueSpec(ctx.issue);
  if (r.kind === "invalid")
    return { state: specHalt(state, `approved spec ${r.why}`), halted: true };
  const built = state.pipelineState.specSha;
  if (built !== undefined && (r.kind === "none" || r.spec.sha256 !== built))
    return {
      state: specHalt(
        state,
        "approved spec is not the one explore read: the cycle was built against another",
      ),
      halted: true,
    };
  if (r.kind === "none" || r.spec.block !== 1) return { state };
  if (state.pipelineState.specBlock?.includes(` sha256:${r.spec.sha256}`)) return { state };
  const wt = lensWorktree(ctx, state);
  const exec = ctx.verifyExecFn ?? execp;
  const git = (argv: string[]) =>
    exec("git", { argv, cwd: wt, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const head = (
    await git(["rev-parse", "HEAD"]).catch(() => ({ stdout: "unknown" }))
  ).stdout.trim();
  const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).catch(
    () => ({ stdout: "" }),
  );
  const headFiles = new Set(listed.stdout.split("\0").filter((p) => p !== ""));
  let result: DispatchResult | undefined;
  const { lines } = await specCheckLines(
    { spec: r.spec, worktree: wt, head, headFiles },
    async (s, arms) => {
      result = await cycleDispatch(ctx)(ctx.host, s, {
        label: "spec-check",
        ...(arms.opts.childBoundMs === undefined ? {} : { childBoundMs: arms.opts.childBoundMs }),
        deck: driverDeckOpts(ctx.issue, "commit-pr", "spec-check"),
      });
      return result;
    },
  );
  // An interrupt never pins a "did not run" block; the loop records it.
  if (ctx.signal?.aborted === true) return { state, halted: true };
  // Cached in its published form: every body write path-normalises and then looks for these exact bytes.
  const specBlock = normaliseDriverPublishPaths(renderSpecBlock(r.spec, lines), {
    repoRoot: ctx.repoRoot,
  }).text;
  let next: WorkState = { ...state, pipelineState: { ...state.pipelineState, specBlock } };
  if (result !== undefined)
    next = appendEvent(
      next,
      await buildCompletionEvent(ctx, "commit-pr", "explore", "spec-check", result),
    );
  await persistCycle(ctx, next);
  return { state: next };
}

/**
 * After every commit-pr outcome: the PR body ends in the cycle's block, or the
 * cycle halts. `undefined` when there is nothing to do or the body was
 * repaired; otherwise the halted state.
 */
export async function specBlockOnPr(
  ctx: CycleContext,
  execFn: VerifyExecFn,
  state: WorkState,
): Promise<WorkState | undefined> {
  const block = state.pipelineState.specBlock;
  if (block === undefined) return undefined;
  const halt = (why: string) => specHalt(state, `approved spec block: ${why}`);
  const pr = state.pipelineState.prNumber;
  if (pr === undefined) return halt("the PR number is not known");
  const forge = await forgeForCycle(ctx, execFn);
  if (!forge) return halt("the forge is not known");
  let current: string;
  try {
    current = (await forge.prView(pr)).body ?? "";
  } catch (err) {
    return halt(`the PR body could not be read: ${(err as Error).message?.slice(0, 160)}`);
  }
  const composed = specBlocked(current, block);
  if (composed === current && specBlockProblem(current) === undefined) return undefined;
  if (forge.forge !== "github")
    return halt("the PR body has no valid block and this forge has no driver body edit");
  try {
    const wrote = await writePrBody(ctx, state, execFn, pr, composed, "spec");
    return wrote.ok ? undefined : halt(wrote.reason);
  } catch (err) {
    return halt(`the PR body write failed: ${(err as Error).message?.slice(0, 160)}`);
  }
}
