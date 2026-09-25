#!/usr/bin/env bun
/**
 * Every driver dispatch site either carries an explicit cwd or is declared
 * repoRoot-intentional.
 *
 * `spawn.ts` resolves `spec.cwd ?? process.cwd()` — a DispatchSpec with no
 * cwd silently runs in the Pi process directory, which for a driver-launched
 * child is the repository root. Issue #741's develop dispatch did exactly
 * this and wrote a 260-line source file to repoRoot; the stray file survived
 * the cycle and poisoned the next one's consolidated verify 50 minutes in.
 *
 * This canary is the audit that issue #746's decision recorded:
 *
 *   - the repoRoot-intentional allowlist (decision #5) is
 *     branch-ops, commit-pr, merged, step-back (both sites), explore, plan,
 *     policy judge, handoff, and the consolidated verify itself. These act at
 *     the integration point on purpose; forcing a worktree cwd on them would
 *     be a behaviour change.
 *   - every OTHER driver dispatch site must carry an explicit cwd — either
 *     one threaded onto the DispatchSpec directly (develop, speculative
 *     explore, dependent workstreams, the converge corrective, lens-fix) or
 *     one resolved by a named function that returns the assigned worktree
 *     (adversarial via `worktrees[id]`, lens review via `lensWorktree`).
 *
 * The check is source-level by design: a missing `cwd` key is invisible to
 * the runtime until a workstream happens to lack a worktree entry, so the
 * only reliable detector is one that reads the dispatch sites.
 *
 * If a new dispatch site appears, add it to `ROOT_INTENTIONAL_SITES` (with
 * a reason — it must genuinely act at the integration point) or give it a
 * cwd. An undeclared, cwd-less site fails this test.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const read = (f: string) =>
  readFileSync(path.join(SRC, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/**
 * The repoRoot-intentional allowlist — issue #746 decision #5, verbatim.
 * Each entry: the file, a regex that identifies the dispatch site, and why
 * the site legitimately acts at the integration point.
 */
const ROOT_INTENTIONAL_SITES: Array<{ file: string; site: RegExp; label: string; why: string }> = [
  {
    file: "work-driver-branch-ops.ts",
    site: /runSingleDispatch\(\s*ctx,\s*base,\s*"branch",\s*"ops",\s*"ops"/,
    label: "branch-ops (ops:branch)",
    why: "creates the feature branch and the worktrees — it cannot run inside a worktree it has not made yet",
  },
  {
    file: "work-driver-commit.ts",
    site: /runSingleDispatch\(\s*ctx,\s*preDispatch,\s*"commit-pr",\s*"ops",\s*"ops:commit-pr"/,
    label: "commit-pr (ops:commit-pr)",
    why: "stages the consolidated diff at the integration point where the worktrees' commits are applied",
  },
  {
    file: "work-driver-merged.ts",
    site: /runSingleDispatch\(\s*ctx,\s*preDispatch,\s*"merged",\s*"ops",\s*"ops:merge"/,
    label: "merged (ops:merge)",
    why: "the merge acts on the PR at the integration point; worktrees are torn down right after",
  },
  {
    file: "work-driver-stepback-ci.ts",
    site: /runSingleDispatch\(\s*ctx,\s*state,\s*"step-back",\s*"explore",\s*"explore:step-back"/,
    label: "step-back (explore:step-back)",
    why: "a read-only spec-revision analysis of the cycle's findings; nothing of the cycle's work exists yet to pin it to a tree",
  },
  {
    file: "work-driver-stepback-ci.ts",
    site: /runSingleDispatch\(\s*ctx,\s*next,\s*"ci",\s*"ops",\s*"ops:ci"/,
    label: "ci watch (ops:ci)",
    why: "watches the FORGE, not a tree — the worktrees are already committed and pushed at this point",
  },
  {
    file: "work-driver-explore.ts",
    // #799 — the site now carries the slow-run recorder in opts; anchor on
    // the spec + label (onSlow is not part of the cwd audit) rather than
    // requiring the bare opts shape.
    site: /\{\s*role:\s*"explore",\s*prompt\s*\},\s*\{\s*label:\s*"explore"/,
    label: "explore (label: explore)",
    why: "reads the issue and the code at the integration point before any worktree exists",
  },
  {
    file: "work-driver-plan.ts",
    // #754 — the site now carries the plan step's own bound in the opts
    // object; anchor on the spec + label (timeoutMs is not part of the cwd
    // audit) rather than requiring a bare opts.
    site: /\{\s*role:\s*"explore",\s*prompt\s*\},\s*primaryOpts/,
    label: "plan (label: plan)",
    why: "produces the workstream decomposition; the worktrees it describes do not exist until the branch step",
  },
  {
    file: "work-driver-plan.ts",
    site: /\{\s*role:\s*"explore",\s*prompt:\s*correctivePrompt\s*\}/,
    label: "plan:corrective (label: plan:corrective)",
    why: "the one-shot plan re-dispatch — same step, same reason",
  },
  {
    file: "work-driver-plan-helpers.ts",
    site: /\{\s*role:\s*"explore",\s*prompt:\s*correctivePrompt\s*\}/,
    label: "plan:corrective (kill-triggered, helpers)",
    why: "the #754 kill-triggered corrective re-dispatch — same step, same reason as the quality-gate corrective",
  },
  {
    file: "work-driver-policy.ts",
    site: /\{\s*role:\s*"explore",\s*prompt,\s*cwd:\s*repoRoot\s*\}/,
    label: "policy judge (spawnSpecialist)",
    why: "read-only, answers one question against doctrine read from disk — cwd IS set, explicitly, to repoRoot",
  },
  {
    file: "work-driver-handoff-ops.ts",
    site: /\{\s*role:\s*"ops",\s*prompt\s*\},\s*\{\s*label:\s*"ops:handoff"/,
    label: "handoff (ops:handoff)",
    why: "posts the handoff comment to the forge; the cycle's trees are torn down or parked and the operator is being told where to look",
  },
];

// ------------------------------------------- the allowlist sites are real

for (const { file, site, label, why } of ROOT_INTENTIONAL_SITES) {
  const src = read(file);
  assert(site.test(src), `${label} — allowlisted site still present in ${file} (${why})`);
}

// ------------------------------------------- develop fan-out: explicit cwd

{
  const run = read("work-develop-run.ts");
  // The developer dispatch and the speculative-explore dispatch both thread
  // the caller's `cwd` onto their DispatchSpecs.
  const devDispatch = run.match(
    /dispatch\(\s*ctx\.pi,\s*\{[\s\S]{0,400}?cwd,\s*\},\s*\{\s*label:\s*developerLabel[\s\S]{0,80}\}/,
  );
  assert(
    devDispatch !== null,
    "canary: the developer dispatch in makeRunOneWorkstream carries the explicit cwd (its VALUE must never be a fallback — sibling audit)",
  );
  const specDispatch = run.match(
    /dispatch\(\s*ctx\.pi,\s*\{[\s\S]{0,400}?cwd,\s*\},\s*\{\s*label:[\s\S]{0,120}?explore:speculative/,
  );
  assert(
    specDispatch !== null,
    "canary: the speculative-explore dispatch carries the same explicit cwd",
  );
  // Dependent workstreams dispatch only after a successful deferred
  // worktree creation, with the created path as cwd. The dependent phase
  // moved to work-develop-dependent.ts (500-line headroom) — the canary
  // reads that file now.
  const dep = read("work-develop-dependent.ts");
  assert(
    /runOneWorkstream\(\s*id,\s*createdPath\s*\)/.test(dep),
    "canary: dependent workstreams are dispatched with their freshly created worktree path — no fallback",
  );
}

// ------------------------------------------- adversarial: worktree-scoped cwd

{
  const fanout = read("work-driver-adversarial-fanout.ts");
  // The per-workstream adversarial loop is scoped to the workstream's own
  // worktree. The `?? ctx.repoRoot` there is the degenerate last-resort (an
  // id absent from the map), not a cwd-less dispatch — the key is present on
  // the DispatchSpec either way, so spawn.ts never hits the process.cwd()
  // fallback the #741 incident ran on.
  assert(
    /const cwd = state\.pipelineState\.worktrees\?\.\[id\] \?\? ctx\.repoRoot;/.test(fanout),
    "canary: the adversarial loop resolves a per-workstream cwd (worktrees map, repoRoot only as last resort for a missing id)",
  );
  assert(
    /workCwd:\s*cwd,/.test(fanout),
    "canary: ...and threads it to the loop as workCwd — the reviewer never falls back to process.cwd()",
  );
}

// ------------------------------------------- converge corrective: named cwd

{
  const converge = read("work-driver-converge-gate.ts");
  assert(
    /cwd:\s*correctiveCwd,/.test(converge),
    "canary: the converge corrective re-dispatch carries an explicit cwd (the worktree that owns the missing paths)",
  );
}

// ------------------------------------------- lens review + lens-fix: same tree

{
  const lens = read("work-driver-lens.ts");
  assert(
    /cwd:\s*lensWorktree\(ctx,\s*state\)/.test(lens),
    "canary: the lens-fix dispatch passes the lens worktree as cwd (the #663 defect)",
  );
  const uses = lens.match(/lensWorktree\(ctx,\s*state\)/g) ?? [];
  assert(
    uses.length >= 2,
    `canary: the lens review and the lens fix resolve the same tree (${uses.length} call sites)`,
  );
  assert(
    /\{[\s\S]{0,200}?cwd:\s*ctx\.repoRoot,\s*timeoutMs:/.test(lens),
    "canary: the lens review exec runs at repoRoot explicitly — the integration tree that holds every workstream's consolidated work",
  );
}

// ------------------------------------------- the consolidated verify: no cwd, intentional

{
  // runConsolidatedVerify is an exec, not a dispatch — it runs its command at
  // repoRoot on purpose (the combined probe tree). It is on the allowlist
  // because decision #5 named "the consolidated verify itself"; the canary
  // pins that it is exec-scoped (cwd: repoRoot) and not an un-cwd'd dispatch.
  const cv = read("work-driver-consolidated-verify.ts");
  assert(
    /execFn\(verifyCmd,\s*\{\s*cwd:\s*repoRoot/.test(cv),
    "canary: the consolidated verify runs at repoRoot by an explicit exec cwd — the combined probe tree lives there",
  );
  assert(
    !/dispatch\(/.test(cv),
    "canary: the consolidated verify does not dispatch — nothing inside it can hit the process.cwd() fallback",
  );
}

// ------------------------------------------- runSingleDispatch: the shared seam

{
  // The shared helper must keep its cwd option: the lens-fix fix only works
  // because the seam can express one.
  const merged = read("work-driver-merged.ts");
  assert(
    /opts\?:\s*\{[^}]*cwd\?:\s*string/.test(merged),
    "canary: runSingleDispatch still accepts a cwd option — the seam the lens-fix fix relies on",
  );
  assert(
    /\.\.\.\(opts\?\.cwd \? \{ cwd: opts\.cwd \} : \{\}\)/.test(merged),
    "canary: ...and only puts it on the spec when set — callers that pass nothing remain repoRoot-intentional by declaration, not by accident",
  );
}

// ------------------------------------------- census: no dispatch site escapes

{
  // Open-world enumeration: EVERY call site of the five spawn seams
  // (dispatch / dispatchCore / dispatchFn / spawnSpecialist / runSingleDispatch)
  // must live in a file that is either (a) cwd-audited above — the section
  // that pins the file's call sites to an explicit cwd — or (b) allowlisted
  // as repoRoot-intentional (decision #5). The census counts per file so a
  // NEW call site added to an audited file is also caught when the audit
  // section's count no longer matches; an undeclared file fails outright.
  const SEAM = /\b(?:dispatch|dispatchCore|dispatchFn|spawnSpecialist|runSingleDispatch)\(/;
  const perFile: Record<string, number> = {};
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const raw = readFileSync(path.join(SRC, entry.name), "utf8");
    let n = 0;
    for (const line of raw.split("\n")) {
      if (/^\s*\*/.test(line)) continue; // block-comment line
      if (SEAM.test(line)) n += 1;
    }
    // Subtract the file's own seam DEFINITIONS (export function dispatchCore,
    // export function spawnSpecialist) — those are the seams, not call sites.
    const defs =
      raw.match(/^export (?:async )?function (?:dispatchCore|spawnSpecialist)\(/gm)?.length ?? 0;
    const calls = Math.max(0, n - defs);
    if (calls > 0) perFile[entry.name] = (perFile[entry.name] ?? 0) + calls;
  }
  // The /work driver's dispatch seams, per file. A file's census count must
  // EQUAL the count its audit section accounts for: more call sites than
  // audited = an undeclared new site; fewer = the audit is stale (a site
  // moved or was deleted without updating the canary).
  const AUDITED: Record<string, number> = {
    "work-develop-run.ts": 2, // developer + speculative explore (dependents go through runOneWorkstream)
    "work-driver-converge-gate.ts": 1, // the corrective re-dispatch
    "work-driver-lens.ts": 1, // the lens-fix runSingleDispatch (the review is an exec)
    "adversarial.ts": 1, // runPhase's inner spawn — cwd threaded by the fan-out
    "lens-review-child.ts": 1, // the lens child — cwd: runOpts.cwd, set by the lens review seam
  };
  // The /plan and /research drivers' seams — outside the /work driver's
  // scope for this audit (their own cwd hygiene is a separate concern).
  // Their call sites are exempted from the count-matching above.
  const NON_WORK_DRIVER = new Set([
    "plan-driver.ts",
    "plan-gaps.ts",
    "plan-investigate.ts",
    "research-driver.ts",
  ]);
  // The seam's own plumbing: dispatch.ts DEFINES dispatchCore and calls
  // spawnSpecialist internally (the wrapper seam, not a dispatch site);
  // work-driver-resume.ts's `dispatch(es)` hits are string literals in the
  // resume message, not calls; work-driver-merged.ts DEFINES runSingleDispatch
  // (its three call sites are allowlisted above); the fan-out calls the
  // loopFn seam (ctx.adversarialLoopFn ?? runAdversarialLoop) whose cwd is
  // pinned in the adversarial section.
  const SEAM_PLUMBING = new Set([
    "dispatch.ts",
    "work-driver-resume.ts",
    "work-driver-merged.ts",
    "work-driver-adversarial-fanout.ts",
  ]);
  const allowlisted = new Set(ROOT_INTENTIONAL_SITES.map((s) => s.file));
  const problems: string[] = [];
  for (const [file, count] of Object.entries(perFile)) {
    if (allowlisted.has(file)) continue; // decision #5 — declared repoRoot-intentional
    if (SEAM_PLUMBING.has(file)) continue; // the seams themselves — not dispatch sites
    if (NON_WORK_DRIVER.has(file)) continue; // /plan + /research — outside this audit's scope
    const expected = AUDITED[file];
    if (expected === undefined) {
      problems.push(
        `${file}: ${count} call site(s) in a file that is neither allowlisted, cwd-audited, nor seam plumbing`,
      );
    } else if (count !== expected) {
      problems.push(
        `${file}: ${count} call site(s) found but the audit section accounts for ${expected} — a dispatch site moved or a new one was added`,
      );
    }
  }
  assert(
    problems.length === 0,
    problems.length === 0
      ? "census: every spawn-seam call site is in an allowlisted (decision #5) or cwd-audited file, and the counts match the audit sections"
      : `census: unaccounted dispatch sites — \n  ${problems.join("\n  ")}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
