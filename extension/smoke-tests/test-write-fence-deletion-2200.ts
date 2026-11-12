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

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childEnvFor, writeFenceChildEnv } from "../src/write-fence-contract.ts";
import {
  CHILD_TMP_ENV,
  DELETION_LOG_TOKEN,
  deletionRootsFrom,
  firstDeletionOutside,
  registerDeletionGuard,
} from "../src/write-fence-deletion.ts";
import { GIT_CLEAN_LOG_TOKEN } from "../src/write-fence-deletion.ts";
import { withEnv } from "./lib/env-scope.ts";
import { buildDeletionFixture } from "./lib/write-fence-deletion-fixture.ts";

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
const {
  base,
  wt,
  scratch,
  childTmp,
  sharedTmp,
  sharedRuns,
  foreignRunUnderRuns,
  spawnTempRoot,
  foreignRun,
} = fx;

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
  // to protect — and `rm -rf .` there is the incident's damage. The forbidden set is built
  // from ONE fixed union — the env's temp root, the well-known temp spellings and the home
  // directory the shell expands `~` to — so an env that points `TMPDIR` at a tree of the
  // child's choosing cannot shrink it, and a fixture (which never names the machine's own
  // dirs) cannot make the rule pass by being somewhere else.
  // The test's own view of the env the rule reads: an ops child spawned with no `HOME` and no
  // `TMPDIR`, so only the well-known spellings are in play. Without this the block would judge
  // the fixture under the harness's redirected `TMPDIR`, and a scratch tree inside a shared root
  // reads as a different tree from the one its rows are written under.
  await withEnv({ HOME: undefined, TMPDIR: undefined }, async () => {
    const inSharedRoot = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, sharedTmp);
    assert(
      inSharedRoot.allowed.length === 0,
      `G1b: an ops cwd that is the shared temp root (\`${sharedTmp}\`) is not admitted as a root`,
    );
    for (const command of [`rm -rf ${sharedTmp}/pi-rukas-review-victim`, "rm -rf .", "rm -rf x"]) {
      assert(
        firstDeletionOutside(command, inSharedRoot) !== undefined,
        `G1b: an ops child standing IN the temp root cannot run \`${command}\``,
      );
    }
    // Two gates, two rows, because the `tmp`-named cwd is refused by the FIRST of them and a
    // single row would only ever observe that one.
    //
    // Gate 1 — the name. A directory called `tmp` is a temp root by the only convention a child
    // can be told to aim at (`mktemp -p ./tmp`, `TMPDIR=$PWD/tmp`), so the carve-out refuses a cwd
    // that GOES BY that name outright, wherever it sits: the fixture's own `tmp/other-session-run`
    // gets no root at all, though the machine keeps none of its temp dirs anywhere near it, and the
    // child can clean neither that dir nor anything above it.
    const inTmpNamedDir = deletionRootsFrom(
      { PI_ENSEMBLE_ROLE: "ops" },
      path.join(sharedTmp, "named-dir"),
    );
    assert(
      inTmpNamedDir.allowed.length === 0 &&
        firstDeletionOutside("rm -rf .", inTmpNamedDir) !== undefined &&
        firstDeletionOutside("rm -rf keep", inTmpNamedDir) !== undefined,
      "G1b: an ops cwd NAMED `tmp` is refused as a working root by its name, wherever it sits",
    );
    // Gate 2 — containment: what the ancestor walk of `forbiddenWorkingDirectories` decides, and
    // the gate Gate 1 cannot see (the name rule answers that cwd first, so the `tmp`-named tree is
    // useless for observing it). `runs/` is a shared root no basename rule recognises — not `tmp`,
    // not `/tmp`, not this env's temp dir — and it sits beside `spawntmp/`, the synthetic spawn
    // temp root injected below. So the walk climbs from that root and refuses `runs/` for its whole
    // subtree: a cwd under it loses its working directory, and `rm -rf ..` — which reaches the tree
    // holding every other run's temp dir — is refused. Both halves are the walk's doing alone: seed
    // it from a root that is not there and the same cwd keeps its root and `..` runs. Delete the
    // walk (or its `wholeSubtree` containment) and this row goes red while Gate 1 above stays green.
    const inChildOfRuns = deletionRootsFrom(
      { PI_ENSEMBLE_ROLE: "ops" },
      foreignRunUnderRuns,
      () => spawnTempRoot,
    );
    assert(
      inChildOfRuns.allowed.length === 0 &&
        firstDeletionOutside("rm -rf ../..", inChildOfRuns) !== undefined &&
        firstDeletionOutside(`rm -rf ${sharedRuns}`, inChildOfRuns) !== undefined,
      "G1b: an ops cwd under a NON-temp-named shared root is refused by the containment walk alone",
    );
    // The control that makes the row above say something: seed the same walk from a tree that holds
    // no run dir and this cwd is an ordinary working directory again — it keeps its root, so the
    // refusal above is the walk's and not some other rule's. (`rm -rf ..` stays refused there, by
    // the well-known temp spellings that contain this scratch tree; it is the ROOT that the walk
    // takes away, so that is what the pair of rows compares.)
    const noWalk = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, foreignRunUnderRuns, () =>
      path.join(base, "no-such-spawn-tmp"),
    );
    assert(
      noWalk.allowed.length === 1,
      "G1b: with no temp root to climb from, that same cwd is an ordinary working directory",
    );
  });
  // The three spellings of "the temp root" the rule recognises, each from a fixture dir:
  // the process env, the child's own env, and the well-known absolute roots.
  for (const [name, env, cwd] of [
    ["TMPDIR from the process env", {}, process.env.TMPDIR ?? "/tmp"],
    ["TMPDIR carried in the child's env", { TMPDIR: sharedTmp }, sharedTmp],
  ] as Array<[string, Record<string, string | undefined>, string]>) {
    await withEnv(env, async () => {
      const roots = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, cwd);
      assert(
        roots.allowed.length === 0 && firstDeletionOutside("rm -rf .", roots) !== undefined,
        `G1b: an ops cwd that is the temp root (${name}) is refused as a root`,
      );
    });
  }
  // The well-known roots are refused whatever the env says: an empty env (no HOME, no
  // TMPDIR — a trimmed or scrubbed spawn) must not drop the guard, and `$HOME`/`/` are
  // refused as themselves while a checkout under the home directory stays a working tree.
  await withEnv({ HOME: undefined, TMPDIR: undefined }, async () => {
    for (const cwd of ["/", "/tmp", "/var/tmp", "/private/tmp"]) {
      assert(
        deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops" }, cwd).allowed.length === 0,
        `G1b: an ops cwd of \`${cwd}\` is not a working root, HOME-less env included`,
      );
    }
    // A scratch tree the harness built is admitted as a working directory: the rule decides the
    // cwd by where the machine's temp dirs are and what `HOME` the spawn handed over, and it
    // cannot tell a scratch tree from the checkout parked in the same shape. The damage is caught
    // on the TARGET — an absolute delete of a tree outside the roots is refused — which is why
    // the row below keeps a checkout working while the shared root two rows up stays closed.
    const checkout = path.join(base, "projects", "some-checkout");
    mkdirSync(checkout, { recursive: true });
    try {
      const inRepo = deletionRootsFrom({ PI_ENSEMBLE_ROLE: "ops", HOME: base }, checkout);
      assert(
        inRepo.allowed.length === 1 && firstDeletionOutside("rm -rf dist", inRepo) === undefined,
        "G1b: an ops child in a real checkout under $HOME still cleans it",
      );
      assert(
        firstDeletionOutside(`rm -rf ${sharedTmp}/pi-rukas-review-victim`, inRepo) !== undefined,
        "G1b: and an absolute delete of the temp root from that checkout is refused",
      );
      // The env-coupling this row exists for: a machine whose temp dir sits UNDER the home
      // directory — what macOS publishes as `$TMPDIR`, and any operator who parks their scratch at
      // `~/tmp` — is the shape that silently closed the carve-out, because the temp roots were read
      // from the parent process while `$HOME` came from the spawn. Pointing `TMPDIR` at a dir under
      // this row's own `$HOME` is that host, reproduced rather than avoided. The tree sits under
      // the OS home, because the rule refuses that too (`os.homedir()`, the passwd entry, which no
      // env can move) and a checkout outside it would be refused for that reason rather than the one
      // under test. The shape is the one a host with a home-relative temp dir really has — a single
      // home tree holding the temp dir and the checkout, exactly where `~` points them, because a
      // checkout parked beside the temp root is refused by the rule that closes the tree holding
      // every run's temp dirs, which is a different rule. The checkout must still be a working root
      // with its build dir deletable: fail-closed on every ops spawn is what these two assertions
      // refuse to let the code do quietly. `TMPDIR` is the variable under test, not the machine's.
      const hostTree = mkdtempSync(path.join(os.homedir(), ".pi-rukas-2200-host-"));
      const realCheckout = path.join(hostTree, "projects", "checkout");
      // NOT named `tmp`: a directory bearing a temp root's name is refused wherever it sits, which
      // is a different rule and would decide this row before the env-coupling under test got asked.
      const homeTmp = path.join(hostTree, "machinetmp");
      mkdirSync(realCheckout, { recursive: true });
      mkdirSync(homeTmp, { recursive: true });
      const tmpInsideHome = deletionRootsFrom(
        { PI_ENSEMBLE_ROLE: "ops", HOME: hostTree, TMPDIR: homeTmp },
        realCheckout,
      );
      assert(
        tmpInsideHome.allowed.length === 1 &&
          firstDeletionOutside("rm -rf dist", tmpInsideHome) === undefined &&
          firstDeletionOutside("rm -rf node_modules", tmpInsideHome) === undefined,
        "G1b: an ops child still cleans its checkout when the machine's temp dir sits under $HOME",
      );
      assert(
        firstDeletionOutside(`rm -rf ${homeTmp}/victim`, tmpInsideHome) !== undefined,
        "G1b: and that same env still refuses a delete inside the temp dir it points at",
      );
      rmSync(hostTree, { recursive: true, force: true });
    } finally {
      rmSync(path.join(base, "projects"), { recursive: true, force: true });
    }
  });
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
console.log(`\nexit ${exit}`);
process.exit(exit);
