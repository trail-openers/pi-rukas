/**
 * test-reviewer-probe-containment-2352 — the field shape, replayed through the
 * registered hook (#2352).
 *
 * Three /work cycles in one day ended the same way: an adversarial or lens child
 * probing a target project moved that project's live state directory into its
 * scratch and restored it by copying, planted thousands of files in it, and left a
 * name with a leading space plus a symlink behind. None of that is a reviewer
 * needing a package or a build — it is a reviewer reaching into state it was never
 * given — and none of it was refused, because the two bash rules that judge a
 * child stand aside for a role with no write root.
 *
 * This test builds the fixture the field had — a live project with a state dir, a
 * scratch dir, and a reviewer child whose bash is judged by the real registered
 * hook — and replays each observed shape as the child would have issued it. The
 * assertion is not "the guard has a rule for this verb": it is that after the child
 * ran its command, the operator's tree is BYTE-IDENTICAL and the refusal is in the
 * log. Everything the child legitimately does (read, grep, git status, run the
 * target's compiler) has to still run, or the guard is a reviewer that cannot
 * review and the issue is not done.
 */

import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import {
  REVIEWER_WRITE_LOG_TOKEN,
  firstReviewerWriteOutside,
  registerReviewerWriteGuard,
  reviewerRootsFrom,
} from "../src/write-fence-reviewer.ts";

type Handler = (event: { toolName: string; input?: unknown }) => Promise<
  { block: boolean; reason?: string } | undefined
>;

/** Every byte under `dir`, sorted, as `rel:sha` — the identity a probe must not change. */
async function fingerprint(dir: string): Promise<string> {
  const walk = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(`${p}:link->${readlinkSync(p)}`);
      else if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(`${p}:${Bun.hash(readFileSync(p)).toString(16)}:${statSync(p).size}`);
    }
    return out;
  };
  return (await walk(dir)).join("\n");
}

async function run() {
  const root = mkdtempSync(path.join(tmpdir(), "probe-2352-"));
  // The fixture: a target project with a live state dir (the field's `.state`, with
  // a memory file in it), the reviewer's per-spawn scratch, and its reviewer tree.
  const project = path.join(root, "target");
  const state = path.join(project, ".state");
  const scratch = path.join(root, "ct");
  const worktree = path.join(root, "wt");
  const logDir = path.join(root, "log");
  for (const d of [state, scratch, worktree, logDir]) mkdirSync(d, { recursive: true });
  await Bun.write(path.join(state, "memory.json"), '{"rows":1}');
  await Bun.write(path.join(project, "index.ts"), "export const a = 1;\n");

  const hooks: Handler[] = [];
  registerReviewerWriteGuard({ on: (_e: string, h: Handler) => hooks.push(h) } as never, {
    env: {
      [CHILD_TMP_ENV]: scratch,
      PI_ENSEMBLE_ROLE: "adversarial-developer",
      PI_ENSEMBLE_WRITE_SCRATCH: logDir,
    } as never,
    cwd: worktree,
  });
  assert.equal(hooks.length, 1, "a confined role's child has the hook installed");
  const run1 = async (command: string) => hooks[0]({ toolName: "bash", input: { command } });

  const before = await fingerprint(project);

  console.log("── the three field shapes ──");
  const field = [
    // 1. moved the live state dir into scratch, restored it by copying it back
    `mv ${state} ${scratch}/stashed && cp -a ${scratch}/stashed ${project}/.state`,
    // 2. planted files in the live tree (thousands, in the field; two here)
    `touch ${state}/planted-1 ${state}/planted-2`,
    // 3. the name with a leading space, and the symlink
    `touch "${state}/ planted"`,
    `ln -s ${scratch}/x ${state}/link`,
  ];
  for (const command of field) {
    const verdict = await run1(command);
    assert.equal(verdict?.block, true, `blocked: ${command}`);
    assert.ok(verdict?.reason?.startsWith("Refused:"), `a reason the child can act on: ${command}`);
  }
  assert.equal(await fingerprint(project), before, "the live tree is byte-identical");
  assert.ok(existsSync(path.join(state, "memory.json")), "and its file is still there");
  assert.deepEqual(
    readdirSync(state).sort(),
    ["memory.json"],
    "nothing was planted, nothing was linked",
  );

  console.log("── the reads a reviewer must still do ──");
  const review = [
    `cat ${state}/memory.json`,
    `ls -la ${project}`,
    `grep -rn 'export' ${project}/*.ts`,
    `git -C ${project} status --porcelain`,
    `git -C ${project} log --oneline -n 5`,
    `bun run --cwd ${project} tsc --noEmit`,
    `find ${project} -name '*.ts' -print`,
    `wc -l ${project}/index.ts`,
    `du -sh ${project}`,
  ];
  for (const command of review) {
    assert.equal(await run1(command), undefined, `allowed: ${command}`);
  }

  console.log("── the child's own scratch stays writable ──");
  const own = [
    `touch ${scratch}/notes.md`,
    `mkdir -p ${worktree}/evidence`,
    `cp ${state}/memory.json ${worktree}/copy.json`,
    `mv ${worktree}/copy.json ${worktree}/evidence/copy.json`,
    `rm -rf ${worktree}/evidence`,
    `echo found > ${scratch}/out.txt`,
  ];
  for (const command of own) {
    assert.equal(await run1(command), undefined, `allowed: ${command}`);
  }
  assert.equal(await fingerprint(project), before, "and the live tree still never changed");

  console.log("── the refusals were counted, not just spoken ──");
  const logged = readdirSync(logDir).filter((f) => f.startsWith("write-fence-"));
  assert.ok(logged.length > 0, "the refusals are in the write-fence channel");
  const lines = (await Bun.file(path.join(logDir, logged[0])).text()).trim().split("\n");
  assert.equal(lines.length, field.length, "one line per refused call");
  for (const line of lines) {
    const rec = JSON.parse(line) as { tool: string; path: string; reason: string };
    assert.equal(rec.tool, "bash");
    assert.ok(
      rec.path === REVIEWER_WRITE_LOG_TOKEN || rec.path.startsWith("("),
      `the log names the rule, not the target (${rec.path})`,
    );
    assert.ok(
      !rec.path.includes(state) && !rec.reason.includes(state),
      "the target is never logged",
    );
  }

  console.log("── the same commands, judged as the guard's own unit ──");
  const roots = reviewerRootsFrom({ [CHILD_TMP_ENV]: scratch }, worktree);
  for (const command of field) {
    assert.ok(firstReviewerWriteOutside(command, roots) !== undefined, `judge refuses: ${command}`);
  }
  for (const command of review) {
    assert.equal(firstReviewerWriteOutside(command, roots), undefined, `judge allows: ${command}`);
  }

  console.log("── the escape hatch is real ──");
  const off: Handler[] = [];
  registerReviewerWriteGuard({ on: (_e: string, h: Handler) => off.push(h) } as never, {
    env: {
      [CHILD_TMP_ENV]: scratch,
      PI_ENSEMBLE_ROLE: "adversarial-developer",
      PI_ENSEMBLE_REVIEWER_WRITE_GUARD: "0",
    } as never,
    cwd: worktree,
  });
  assert.equal(off.length, 0, "PI_ENSEMBLE_REVIEWER_WRITE_GUARD=0 registers nothing at all");

  console.log("── a developer child is the driver's fence, not this one's ──");
  const dev: Handler[] = [];
  registerReviewerWriteGuard({ on: (_e: string, h: Handler) => dev.push(h) } as never, {
    env: { [CHILD_TMP_ENV]: scratch, PI_ENSEMBLE_ROLE: "developer" } as never,
    cwd: worktree,
  });
  assert.equal(dev.length, 0, "a developer registers nothing (its fence has the roots)");

  rmSync(root, { recursive: true, force: true });
  console.log("\nreviewer probe containment (#2352): all groups passed");
}

await run();
