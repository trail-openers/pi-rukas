#!/usr/bin/env bun
/**
 * #2200 — the child deletion rule (write-fence-deletion.ts): what a child may
 * remove, and what no child may remove at all.
 *
 * The field evidence: a /work develop child hit a disk-quota error in the
 * operator's SHARED temp root and cleared it itself — about fifty commands
 * (`rm -rf`/`rmdir` on literal paths, a `find … -print0 | xargs -0 -r rm -rf`
 * sweep over thirty name prefixes, an `rm -rf` of a VCS root kept under that
 * root). The whole-tree WRITE fence refused only the glob and unresolvable forms:
 * the write rule lets anything land under the OS temp dirs, so every LITERAL
 * delete outside the child's worktree went through.
 *
 * The rule this pins is the opposite allowance: a shared temp root is NEVER a
 * delete target. The roots are the worktree, the cycle scratch dir and the
 * child's OWN per-child temp dir — and the hook has no switch, so the reviewer
 * (no write root) and the `PI_ENSEMBLE_WRITE_FENCE=0` hatch are still judged.
 *
 * Which command shapes count as a deletion (the incident's literal paths, the
 * shared root under any name, the `xargs` sweep, the interpreter one-liners, a
 * remover behind a `sudo`-class wrapper, and the in-tree cleanups that must stay
 * allowed) is pinned in `test-write-fence-deletion-shapes-2200.ts`; this file
 * covers the hook around that reader:
 *
 *   C. the no-hatch case: the hook is gated on neither the fence config nor the
 *      operator's switch (D5), and a reviewer-role child with no write root is
 *      still refused (D2);
 *   D. the refusal names the rule and the allowed roots and NEVER the target
 *      (D6), and the log carries a fixed non-path token, or the ungated warn
 *      when the child has no scratch to append to (D2);
 *   E. `git clean` (D1): refused outside the roots whatever the git-guard opt-out
 *      says, allowed inside (that predicate owns the in-tree case), `-n` allowed;
 *   F. the registration canary: `registerDeletionGuard(failClosedPi(pi))` sits
 *      beside `registerWriteFence` and ABOVE the `PI_ENSEMBLE_SUBAGENT_MODE`
 *      no-op, so a strict/headless child carries the hook too (D10);
 *   G. the scope: the rule judges the children the driver can name a root for —
 *      a fenced develop/lens-fix dispatch, and the reviewer / lean / nested child
 *      the driver never fences, which is then refused everything (the driver owns
 *      that child's trees). An `ops` dispatch is neither: it works in the operator's
 *      checkout and the issue's own out-of-scope list keeps parent-side work, and
 *      the operator's commands, outside this rule — so an ops child's delete inside
 *      its own cwd is left alone, while one aimed at the shared root is not.
 *
 * Observed RED on the code before this change: the `git clean` rows after a `cd`,
 * and the canary.
 */

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { childEnvFor, writeFenceChildEnv } from "../src/write-fence-contract.ts";
import {
  CHILD_TMP_ENV,
  DELETION_LOG_TOKEN,
  deletionRootsFrom,
  firstDeletionOutside,
  registerDeletionGuard,
} from "../src/write-fence-deletion.ts";
import { GIT_CLEAN_LOG_TOKEN } from "../src/write-fence-deletion.ts";
import { buildDeletionFixture } from "./lib/write-fence-deletion-fixture.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(name: string, fn: Handler) {
      handlers[name] = [...(handlers[name] ?? []), fn];
    },
  } as unknown as ExtensionAPI & { handlers: Record<string, Handler[]> };
}
async function toolCall(pi: { handlers: Record<string, Handler[]> }, command: string) {
  const results = await Promise.all(
    (pi.handlers.tool_call ?? []).map((h) =>
      h({ type: "tool_call", toolName: "bash", input: { command } }, {}),
    ),
  );
  return results.find((r) => r !== undefined) as { block: true; reason: string } | undefined;
}

// ---------------------------------------------------------------- the fixture
//
// The layout (worktree, scratch, the child's own temp dir, a shared temp root of
// its own, a sibling child's root and a harness-owned tree) is shared with the
// other #2200 file; see `lib/write-fence-deletion-fixture.ts`.
const fx = buildDeletionFixture("hook");
const { base, wt, scratch, childTmp, sharedTmp, foreignRun } = fx;

/** The roots a fenced develop child's dispatch gives it; the child works in the worktree. */
const FENCED_ENV = {
  PI_ENSEMBLE_WRITE_ROOT: wt,
  PI_ENSEMBLE_WRITE_REPO: base,
  PI_ENSEMBLE_WRITE_SCRATCH: scratch,
  [CHILD_TMP_ENV]: childTmp,
};
const fenced = deletionRootsFrom(FENCED_ENV, wt);

/** The refusal reason the rule gives this command, or undefined when it runs. */
function refused(command: string, roots = fenced): string | undefined {
  return firstDeletionOutside(command, roots)?.reason;
}

/** Every refusal the child logged into its scratch dir. */
function loggedRefusals(): Array<{ tool: string; path: string; reason: string }> {
  const out: Array<{ tool: string; path: string; reason: string }> = [];
  for (const f of readdirSync(scratch)) {
    if (!f.startsWith("write-fence-")) continue;
    for (const line of readFileSync(path.join(scratch, f), "utf8").split("\n")) {
      if (line.trim() !== "") out.push(JSON.parse(line) as { tool: string; path: string });
    }
  }
  return out;
}

/** Register a hook whose roots come from exactly this env, in the child's cwd. */
function registerDeletionGuardWith(env: Record<string, string>, cwd: string = wt) {
  const pi = fakePi();
  registerDeletionGuard(pi, { env, cwd });
  return pi;
}

// ============================================================
// C. No hatch, and no write root: the cases the fence config cannot express.
// ============================================================
{
  // C1 — the operator's escape hatch switches off the WRITE fence only.
  const pi = fakePi();
  registerDeletionGuard(pi, { env: { ...FENCED_ENV, PI_ENSEMBLE_WRITE_FENCE: "0" }, cwd: wt });
  assert((pi.handlers.tool_call ?? []).length === 1, "C1: the hook registers under the hatch");
  const r = await toolCall(pi, `rm -rf ${foreignRun}`);
  assert(r?.block === true, "C1: PI_ENSEMBLE_WRITE_FENCE=0 does not disarm the deletion rule");
}
{
  // C2 — a reviewer-role child: no write root, no scratch, the hatch set. Its
  // deletion refusal is still enforced (it is simply uncounted, D2).
  const pi = fakePi();
  registerDeletionGuard(pi, {
    env: { PI_ENSEMBLE_ROLE: "code-review-specialist", PI_ENSEMBLE_WRITE_FENCE: "0" },
    cwd: base,
  });
  assert((pi.handlers.tool_call ?? []).length === 1, "C2: the hook registers with no write root");
  const r = await toolCall(pi, `rm -rf ${sharedTmp}`);
  assert(r?.block === true, "C2: a reviewer-role child with no write root is still refused");
  const own = await toolCall(registerDeletionGuardWith(FENCED_ENV), `rm -rf ${childTmp}`);
  assert(own === undefined, "C2: the child's own temp dir stays deletable for a reviewer too");
  const unfenced = await toolCall(
    registerDeletionGuardWith({ PI_ENSEMBLE_ROLE: "code-review-specialist" }),
    `rm -rf ${sharedTmp}`,
  );
  assert(unfenced?.block === true, "C2: and with no roots at all nothing is deletable");
}
{
  // C3 — the per-child temp root alone is enough to delete into; nothing else is.
  const roots = deletionRootsFrom({ [CHILD_TMP_ENV]: childTmp }, base);
  assert(
    refused(`rm -rf ${childTmp}/probe.txt`, roots) === undefined,
    "C3: a child with only its temp root can clean it",
  );
  assert(refused(`rm -rf ${foreignRun}`, roots) !== undefined, "C3: and nothing outside it");
}
{
  // C4 — `find` with no start path deletes the working directory: judged, not ignored.
  const nowhere = deletionRootsFrom({}, wt);
  assert(
    refused("find -maxdepth 1 -name 'x-*' -delete", nowhere) !== undefined,
    "C4: a `find -delete` with no start path is judged against the cwd",
  );
  assert(
    refused("find -maxdepth 1 -name 'x-*' -delete") === undefined,
    "C4: the same command inside the worktree still runs",
  );
}
{
  // C5 — the per-child temp root is STRIPPED from a nested child's env (#2200). A
  // dispatch made inside a child runs `childEnvFor` before `spawn.ts` sets the
  // value for its own dir; if the parent's value survived, a nested (unfenced,
  // lean, lens-review) child would inherit a deletable root it does not own — and
  // on a host whose `TMPDIR` is a shared root that root is the incident's shape.
  const nested = childEnvFor({ [CHILD_TMP_ENV]: sharedTmp, PATH: "/bin" }, "explore");
  assert(
    nested[CHILD_TMP_ENV] === undefined,
    "C5: childEnvFor strips an inherited per-child temp root",
  );
  assert(
    (writeFenceChildEnv(undefined)[CHILD_TMP_ENV] ?? undefined) === undefined,
    "C5: an unfenced dispatch sets no temp root of its own",
  );
  const inherited = deletionRootsFrom(nested, base);
  assert(
    inherited.allowed.length === 0,
    "C5: the nested child has no allowed root, so it cannot inherit one",
  );
  assert(
    refused(`rm -rf ${sharedTmp}/victim`, inherited) !== undefined,
    "C5: the shared root stays refused for the nested child that inherited the value",
  );
}

// ============================================================
// D. The refusal text and the log line.
// ============================================================
{
  const pi = fakePi();
  registerDeletionGuard(pi, { env: FENCED_ENV, cwd: wt });
  const r = await toolCall(pi, `rm -rf ${foreignRun}`);
  const reason = r?.reason ?? "";
  assert(r?.block === true, "D: the hook refuses the shared-root delete");
  assert(reason.includes("Allowed roots:"), "D: the refusal names the allowed roots");
  assert(
    reason.includes(wt) && reason.includes(scratch) && reason.includes(childTmp),
    "D: worktree, scratch and per-child temp dir are all listed",
  );
  assert(
    !reason.includes(foreignRun) && !reason.includes("other-session-run"),
    "D: the refusal never names the target (the handoff is public)",
  );
  const lines = loggedRefusals();
  assert(
    lines.some((l) => l.path === DELETION_LOG_TOKEN && l.tool === "bash"),
    `D: the refusal is logged with the fixed token ${DELETION_LOG_TOKEN}, not the target`,
  );
}
{
  // D2 — the git-clean row logs under its own token, so the driver can tell the
  // two rules apart in the count.
  const pi = fakePi();
  registerDeletionGuard(pi, { env: FENCED_ENV, cwd: wt });
  const r = await toolCall(pi, `git -C ${sharedTmp} clean -fdx`);
  assert(r?.block === true, "D: the shared-root `git clean` is refused");
  const lines = loggedRefusals();
  assert(
    lines.some((l) => l.path === GIT_CLEAN_LOG_TOKEN),
    `D: it is logged with the fixed token ${GIT_CLEAN_LOG_TOKEN}`,
  );
}
{
  // D3 — a child with no scratch has no log to append to: the refusal still
  // blocks, and the record is the ungated warn, declared uncounted there.
  const pi = fakePi();
  registerDeletionGuard(pi, { env: { PI_ENSEMBLE_ROLE: "explore" }, cwd: base });
  const r = await toolCall(pi, `rm -rf ${sharedTmp}`);
  assert(r?.block === true, "D: an uncounted child's delete is still refused");
  assert(
    !((r?.reason ?? "").includes(sharedTmp) || (r?.reason ?? "").includes("other-session-run")),
    "D: the uncounted refusal does not name the target either",
  );
  assert(
    loggedRefusals().every((l) => l.reason !== r?.reason),
    "D: an uncounted refusal never lands in another child's log",
  );
}

// ============================================================
// E. `git clean` (D1).
// ============================================================
{
  assert(
    refused(`git -C ${sharedTmp} clean -fdx`) !== undefined,
    "E: a forcing clean aimed at the shared temp root is refused",
  );
  assert(
    refused(`cd ${sharedTmp} && git clean -fdx`) !== undefined,
    "E: a forcing clean after `cd` into the shared root is refused",
  );
  assert(refused("git clean -n") === undefined, "E: `git clean -n` is a dry run and runs");
  assert(
    refused("git clean --dry-run -f") === undefined,
    "E: `git clean --dry-run -f` is still a dry run",
  );
  assert(refused(`git -C ${wt} clean -fdx`) === undefined, "E: inside the worktree it runs");
  // The git guard's own opt-out is about the child's working tree, so it cannot
  // open the shared root: the refusal stands whatever that switch says.
  const pi = fakePi();
  registerDeletionGuard(pi, {
    env: { ...FENCED_ENV, PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT: "1" },
    cwd: wt,
  });
  const r = await toolCall(pi, `git -C ${sharedTmp} clean -fdx`);
  assert(r?.block === true, "E: PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT does not open the shared root");
}

// ============================================================
// G. The scope: which children carry the hook.
// ============================================================
{
  // G1 — an ops dispatch is never fenced by the driver, but it is the one role
  // that works in the operator's own checkout and does git/PR work there. Only
  // deletes it cannot justify are refused: its own cwd is a working root, the
  // shared temp root is not (#2200's acceptance addition).
  const ops = registerDeletionGuardWith({ PI_ENSEMBLE_ROLE: "ops" }, wt);
  const inCwd = await toolCall(ops, "rm -rf dist");
  assert(
    inCwd === undefined,
    `G: an ops child's in-cwd \`rm -rf dist\` is not refused by this guard (got ${JSON.stringify(inCwd)})`,
  );
  const inCwdRm = await toolCall(ops, `rm -rf ${wt}/node_modules`);
  assert(inCwdRm === undefined, "G: nor an in-cwd delete named absolutely");
  const shared = await toolCall(ops, `rm -rf ${foreignRun}`);
  assert(shared?.block === true, "G: and an ops delete of the shared temp root is still refused");
}
{
  // G1b — the carve-out cannot be widened by pointing the ops child's cwd at a shared tree.
  // The driver dispatches ops at the checkout (`roles.ts`: `cwd: "repo"`), so a cwd that IS
  // a temp root, $HOME or / is a spawn that aimed the role at the very tree the rule exists
  // to protect — and `rm -rf .` there is the incident's damage. These rows use the machine's
  // real temp root (the fixture's shared root is a repo-relative tree, which no role may
  // delete into at all), and name their targets absolutely so they test the root rather than
  // the process's working directory.
  const realTmp = os.tmpdir();
  const inSharedRoot = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, realTmp);
  assert(
    inSharedRoot.allowed.length === 0,
    `G1b: an ops cwd that is the OS temp root (\`${realTmp}\`) is not admitted as a root`,
  );
  for (const command of [`rm -rf ${realTmp}/pi-rukas-review-victim`, "rm -rf .", "rm -rf x"]) {
    assert(
      firstDeletionOutside(command, inSharedRoot) !== undefined,
      `G1b: an ops child standing IN the temp root cannot run \`${command}\``,
    );
  }
  // One level deeper is the same damage: the reader resolves the path before it judges it,
  // so `rm -rf ..` from a child dir reaches the shared root itself.
  const inChildOfTmp = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, `${realTmp}/one-run`);
  assert(
    inChildOfTmp.allowed.length === 0 &&
      firstDeletionOutside("rm -rf ..", inChildOfTmp) !== undefined,
    "G1b: an ops child in a dir under the temp root is refused the root and `..` alike",
  );
  // $HOME and / are refused as themselves — a role has no business standing there. Read from
  // the OS, so an env that carries no HOME or TMPDIR (a trimmed child env) opens nothing.
  assert(
    deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, os.homedir()).allowed.length === 0,
    "G1b: an ops cwd of $HOME is not a working root, HOME-less env included",
  );
  assert(
    deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, "/").allowed.length === 0,
    "G1b: an ops cwd of / is not a working root",
  );
  // And the carve-out still works where it should: a real working tree — a checkout under
  // $HOME, which is where the driver actually sends ops — stays deletable where it stands,
  // while a sibling tree reached through `..` is not.
  const checkout = path.join(os.homedir(), "projects", "some-checkout");
  mkdirSync(checkout, { recursive: true });
  const inRepo = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, checkout);
  assert(
    inRepo.allowed.length === 1 && firstDeletionOutside("rm -rf dist", inRepo) === undefined,
    "G1b: an ops child in a real checkout still cleans it",
  );
  assert(
    firstDeletionOutside(`rm -rf ${realTmp}/pi-rukas-review-victim`, inRepo) !== undefined,
    "G1b: and an absolute delete of the temp root from that checkout is refused",
  );
}
{
  // G2 — the driver-fenced developer child is unchanged: it may delete its own
  // tree and nothing else.
  const dev = registerDeletionGuardWith({ ...FENCED_ENV, PI_ENSEMBLE_ROLE: "developer" });
  assert(
    (await toolCall(dev, `rm -rf ${wt}/build`)) === undefined,
    "G: a fenced developer still cleans its worktree",
  );
  assert(
    (await toolCall(dev, `rm -rf ${foreignRun}`))?.block === true,
    "G: and is still refused outside it",
  );
}
{
  // G3 — the driver never fences a reviewer, a lean or a nested child: the driver
  // owns those trees, so they keep NO root and every delete stays refused (D2).
  const reviewer = registerDeletionGuardWith({
    PI_ENSEMBLE_ROLE: "code-review-specialist",
    PI_ENSEMBLE_WRITE_FENCE: "0",
  });
  assert(
    (await toolCall(reviewer, `rm -rf ${scratch}/notes.txt`))?.block === true,
    "G: an unfenced reviewer child is still refused every delete",
  );
}
{
  // G4 — the companion is where the rule is registered for a child, so the ops
  // carve-out has to survive the companion's own registration path: an ops child
  // loaded through `childGuards` (the argv every child gets) runs its in-cwd clean.
  await withEnv({ PI_ENSEMBLE_ROLE: "ops", PI_ENSEMBLE_SUBAGENT_MODE: "1" }, async () => {
    const fake = fakePi();
    childGuards(fake as unknown as ExtensionAPI);
    const results = await Promise.all(
      (fake.handlers.tool_call ?? []).map((h) =>
        h({ toolName: "bash", input: { command: "rm -rf dist" } }, {}),
      ),
    );
    assert(
      results.every((x) => x === undefined),
      `G: the companion leaves an ops child's in-cwd \`rm -rf dist\` alone (got ${JSON.stringify(results)})`,
    );
  });
}

// ============================================================
// F. Registration canary: above the subagent-mode no-op, beside the fence.
// ============================================================
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "src", "child-guards.ts"), "utf8");
  const deletion = src.indexOf("registerDeletionGuard(failClosedPi(pi))");
  const fence = src.indexOf("registerWriteFence(failClosedPi(pi))");
  const noOp = src.indexOf('if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1")');
  assert(deletion !== -1, "F: registerDeletionGuard(failClosedPi(pi)) is called in child-guards");
  assert(fence !== -1 && noOp !== -1, "F: the fence call and the no-op are both present");
  assert(
    deletion !== -1 && deletion < noOp,
    "F: the deletion rule registers ABOVE the PI_ENSEMBLE_SUBAGENT_MODE no-op",
  );
  assert(
    deletion !== -1 && fence !== -1 && Math.abs(deletion - fence) < 600,
    "F: the deletion rule registers beside the write fence",
  );
}
{
  // The behavioural half: under the subagent-mode no-op the companion still
  // carries the hook, so a strict/headless child is judged too.
  const saved = ["PI_ENSEMBLE_SUBAGENT_MODE", "PI_ENSEMBLE_WRITE_ROOT", "PI_ENSEMBLE_ROLE"].map(
    (k) => [k, process.env[k]] as const,
  );
  process.env.PI_ENSEMBLE_SUBAGENT_MODE = "1";
  delete process.env.PI_ENSEMBLE_WRITE_ROOT;
  delete process.env.PI_ENSEMBLE_ROLE;
  try {
    const companion = fakePi();
    childGuards(companion);
    const r = await toolCall(companion, `rm -rf ${foreignRun}`);
    assert(
      r?.block === true,
      "F: a strict/headless child's companion still refuses a shared-root delete",
    );
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
