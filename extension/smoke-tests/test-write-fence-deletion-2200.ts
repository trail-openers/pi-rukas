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
 *   A. the incident's shapes are refused, literal paths included (A1), the
 *      shared temp root under the names it actually has (A2), a sibling child's
 *      temp root and a harness-owned tree (A3), the `xargs` sweep (A4), and
 *      every interpreter form D7 names (A5);
 *   B. deleting inside the child's own roots still works — the rule is not a
 *      bash ban;
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
 *      no-op, so a strict/headless child carries the hook too (D10).
 *
 * Observed RED on the code before this change: the shared-root rows, `find`
 * without start paths, the template-literal interpreter body, the `git clean`
 * rows after a `cd`, and the canary.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import {
  CHILD_TMP_ENV,
  DELETION_LOG_TOKEN,
  deletionRootsFrom,
  firstDeletionOutside,
  registerDeletionGuard,
} from "../src/write-fence-deletion.ts";
import { GIT_CLEAN_LOG_TOKEN } from "../src/write-fence-deletion.ts";

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
// Everything lives under one directory this file removes on exit, and the
// "shared temp root" is a directory of its own rather than the machine's temp
// dir: the rule must refuse a shared root whatever it is called, and this test
// must never delete outside its own tree.
const scratchParent = path.join(import.meta.dirname, "tmp-issue-2200");
mkdirSync(scratchParent, { recursive: true });
const base = mkdtempSync(path.join(scratchParent, "fixture-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const childTmp = path.join(base, "pi-rukas-child-own");
const sharedTmp = path.join(base, "tmp");
const siblingTmp = path.join(base, "pi-rukas-child-sibling");
const harnessTree = path.join(base, "pi-rukas-review-other");
const foreignRun = path.join(sharedTmp, "other-session-run");
for (const dir of [wt, scratch, childTmp, sharedTmp, siblingTmp, harnessTree, foreignRun]) {
  mkdirSync(dir, { recursive: true });
}
for (const p of [
  path.join(wt, "keep.txt"),
  path.join(scratch, "notes.txt"),
  path.join(childTmp, "probe.txt"),
  path.join(foreignRun, "payload"),
  path.join(siblingTmp, "other-child.txt"),
  path.join(harnessTree, "review-tree.txt"),
]) {
  writeFileSync(p, "x");
}

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
// A1. The incident's shapes: literal paths outside every allowed root.
// ============================================================
const refusedShapes: Array<[string, string]> = [
  [`rm -rf ${foreignRun}`, "the incident's literal `rm -rf` of another run's dir"],
  [`rm ${foreignRun}/payload`, "a literal `rm` of one file outside the roots"],
  [`rmdir ${foreignRun}`, "a literal `rmdir` outside the roots"],
  [`rm -rf ${sharedTmp}`, "a literal `rm -rf` of the shared temp root itself"],
  [
    `find ${sharedTmp} -maxdepth 1 -name 'x-*' -delete`,
    "the acceptance row: `find <sharedTemp> -maxdepth 1 -name 'x-*' -delete`",
  ],
  [
    `find ${sharedTmp} -maxdepth 1 -name 'a-*' -print0 | xargs -0 -r rm -rf`,
    "the incident's prefix sweep through `find … | xargs -0 -r rm -rf`",
  ],
  [`unlink ${foreignRun}/payload`, "`unlink` outside the roots"],
  [`shred -u ${foreignRun}/payload`, "`shred -u` outside the roots"],
  [`cd ${sharedTmp} && rm -rf other-session-run`, "a delete reached through `cd`"],
  [`(cd ${sharedTmp} && rm -rf other-session-run)`, "the same delete inside a subshell"],
  [`rm -rf ${siblingTmp}`, "another child's per-child temp root (D3)"],
  [`rm -rf ${harnessTree}`, "a harness-owned temp tree — a live reviewer checkout (D3)"],
];
for (const [command, why] of refusedShapes) {
  assert(refused(command) !== undefined, `A1 refuse: ${why} — \`${command}\``);
}

// ============================================================
// A2. The shared temp root under the names it actually has.
// ============================================================
for (const root of new Set([sharedTmp, "/tmp", process.env.TMPDIR ?? "/tmp"])) {
  assert(
    refused(`rm -rf ${root}/pi-rukas-review-victim`) !== undefined,
    `A2: a delete under the shared root \`${root}\` is refused`,
  );
}

// ============================================================
// A3. Interpreter one-liners (D7): every call form the spec names.
// ============================================================
const interpreterRefused: Array<[string, string]> = [
  [
    `node -e 'require("fs").rmSync("${foreignRun}", {recursive: true})'`,
    "`node -e` with `rmSync` on a literal path",
  ],
  [`node --eval 'require("fs").rmSync("${foreignRun}")'`, "`node --eval` with `rmSync`"],
  [
    `bun -e 'import fs from "fs"; fs.rmSync("${foreignRun}", {recursive: true})'`,
    "`bun -e` with `rmSync`",
  ],
  [`python -c 'import shutil; shutil.rmtree("${sharedTmp}")'`, "`python -c` with `shutil.rmtree`"],
  [`python3 -c 'import os; os.remove("${foreignRun}/payload")'`, "`python3 -c` with `os.remove`"],
  [`perl -e 'unlink "${foreignRun}/payload"'`, "`perl -e` with `unlink`"],
  [`ruby -e 'FileUtils.rm_rf("${foreignRun}")'`, "`ruby -e` with `rm_rf`"],
];
for (const [command, why] of interpreterRefused) {
  assert(refused(command) !== undefined, `A3 refuse: ${why}`);
}
// The incident's own script shape: the target is built from the environment's
// home directory inside a template literal, so it lives nowhere but the body.
assert(
  refused(
    "node -e 'const p = `${process.env.HOME}/tmp/sweep`; require(\"fs\").rmSync(p, {recursive: true})'",
  ) !== undefined,
  "A3 refuse: an interpreter whose target is a template literal built from HOME",
);
// A dynamic body or a dynamic target cannot be judged, so it does not run.
assert(
  refused("node -e 'require(\"fs\").rmSync(process.env.TARGET, {recursive:true})'") !== undefined,
  "A3 refuse: an interpreter delete whose target is dynamic",
);
assert(refused("bun -e $BODY") !== undefined, "A3 refuse: an interpreter body word that is dynamic");

// ============================================================
// B. The child's own roots stay deletable — the rule is not a bash ban.
// ============================================================
const allowedShapes: Array<[string, string]> = [
  [`rm -rf ${wt}/build`, "a build dir inside the worktree"],
  ["rm -rf ./build", "a relative delete inside the worktree"],
  [`rm ${scratch}/notes.txt`, "the cycle scratch dir"],
  [`rm -rf ${childTmp}`, "the child's OWN per-child temp dir"],
  [`find ${childTmp} -maxdepth 1 -name 'x-*' -delete`, "find -delete over its own temp dir"],
  [`find ${wt} -name '*.log' -delete`, "find -delete inside the worktree"],
  ["git status --porcelain", "an ordinary read-only command"],
  ["bun run check", "the project verify"],
  [`node -e 'console.log("${scratch}/notes.txt")'`, "an interpreter that deletes nothing"],
];
for (const [command, why] of allowedShapes) {
  assert(refused(command) === undefined, `B allow: ${why} — \`${command}\``);
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
  const own = await toolCall(
    registerDeletionGuardWith(FENCED_ENV),
    `rm -rf ${childTmp}`,
  );
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
