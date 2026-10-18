#!/usr/bin/env bun
/**
 * #1655 — the bash side of the write fence (write-fence-bash.ts): which commands
 * are refused, which pass, and where the best-effort line is drawn.
 *
 * Each row is a bash command run from the fenced worktree. A row passes when
 * every target the command would write is allowed by the path rule. The pairs
 * (refused form, same form inside the worktree) are the acceptance criteria.
 */

import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashWriteTargets } from "../src/write-fence-bash.ts";
import { judgeWrite, loadFenceConfig } from "../src/write-fence-path.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fx = buildFenceFixture("bash");
const cfg = loadFenceConfig({
  PI_ENSEMBLE_WRITE_ROOT: fx.wt,
  PI_ENSEMBLE_WRITE_SCRATCH: fx.scratch,
});
if (!cfg) throw new Error("fixture config did not load");

/** The first target the command writes that the rule refuses, or undefined when all pass. */
function refusedTarget(command: string, cwd: string = fx.wt): string | undefined {
  for (const t of bashWriteTargets(command, cwd)) {
    const judged = judgeWrite(t.path, t.cwd, cfg);
    if (!judged.ok) return t.path;
  }
  return undefined;
}

const REPO_BIN = path.join(fx.repo, "bin");

// ------------------------------------------------ the acceptance criteria, refused
const refused: Array<[string, string]> = [
  ["echo x > ../../bin/foo", "a redirect climbing out of the worktree"],
  [`cp a ${REPO_BIN}/b`, "cp into the repo root"],
  [`cp -t ${REPO_BIN} a`, "cp -t into the repo root"],
  [`tee ${REPO_BIN}/x`, "tee into the repo root"],
  [`cd ${fx.repo} && touch x`, "cd to the repo root, then a relative touch"],
  [`mv ${REPO_BIN}/keep ./`, "mv moving a repo-root file (its source is removed)"],
  [`rm ${REPO_BIN}/keep`, "rm of a repo-root file"],
  [`ln -s x ${REPO_BIN}/link`, "ln creating a link in the repo root"],
  [`mkdir -p ${REPO_BIN}/newdir`, "mkdir in the repo root"],
  [`git -C ${fx.repo} status`, "git -C pointing at the repo root"],
  [`sed -i 's/a/b/' ${REPO_BIN}/keep`, "sed -i on a repo-root file"],
  [`echo x | tee ${REPO_BIN}/x`, "a repo-root tee in a pipeline"],
  [`true && echo x > ${REPO_BIN}/x`, "a repo-root redirect after &&"],
  [`echo $(echo hi > ${REPO_BIN}/x)`, "a repo-root redirect inside $(…)"],
  [`echo x >| ${REPO_BIN}/x`, "a noclobber redirect into the repo root"],
  [`echo x &> ${REPO_BIN}/x`, "a combined stdout/stderr redirect into the repo root"],
  [`echo x >> ${REPO_BIN}/x`, "an append into the repo root"],
  [`env FOO=1 cp a ${REPO_BIN}/b`, "cp behind an env wrapper"],
  [`/bin/cp a ${REPO_BIN}/b`, "cp named by its absolute path"],
  ["cd ..", "cd out of the worktree"],
  ["echo x > $HOME/fence-check", "a redirect to $HOME"],
];
for (const [command, why] of refused) {
  assert(refusedTarget(command) !== undefined, `refuse: ${why} — \`${command}\``);
}

// ------------------------------------------------ the same forms inside the worktree, allowed
const allowedForms: Array<[string, string]> = [
  ["echo x > out.txt", "a redirect inside the worktree"],
  ["cp a src/b", "cp inside the worktree"],
  ["cp -t src a", "cp -t inside the worktree"],
  ["tee out.txt", "tee inside the worktree"],
  ["cd src && touch x", "cd into a worktree subdirectory, then touch"],
  ["mv src/a src/b", "mv inside the worktree"],
  ["rm -rf src/x", "rm inside the worktree"],
  ["mkdir -p src/newdir", "mkdir inside the worktree"],
  ["git -C . status", "git -C at the worktree"],
  ["sed -i '/^x/d' src/a.ts", "sed -i with a /-address script (the script is not a path)"],
  [`echo x > ${fx.scratch}/log.md`, "a redirect into the cycle scratch dir"],
  [`echo x > ${path.join(os.tmpdir(), "fence-check")}`, "a redirect into the OS temp dir"],
  ["echo x > /dev/null", "a redirect to /dev/null"],
  ["echo x 2>&1", "an fd duplication (no file is written)"],
  ["echo x 2>/dev/null >out.txt", "a stderr redirect to /dev/null and a stdout redirect inside"],
  ["cat <<EOF > out.txt\nrm /repo/bin/keep\nEOF", "a heredoc body is data, not commands"],
  ["ls -la && cat src/a.ts | grep x", "read-only commands in a chain"],
  ["cp node_modules/pkg/x.js node_modules/pkg/y.js", "cp inside the provisioned dependency tree"],
];
for (const [command, why] of allowedForms) {
  assert(refusedTarget(command) === undefined, `allow: ${why} — \`${command}\``);
}

// ------------------------------------------------ the best-effort line
assert(
  refusedTarget(`sh -c 'echo x > ${REPO_BIN}/x'`) === undefined,
  "best-effort: a body handed to sh -c is opaque here (the residue detection is the backstop)",
);
assert(
  refusedTarget(`eval 'echo x > ${REPO_BIN}/x'`) === undefined,
  "best-effort: an eval body is opaque here",
);
assert(
  refusedTarget(`echo "unterminated > ${REPO_BIN}/x`) === undefined,
  "best-effort: a command that does not lex is allowed",
);
assert(
  refusedTarget("cd -") === undefined,
  "best-effort: `cd -` (OLDPWD is not known statically) is not judged",
);
assert(refusedTarget("") === undefined, "an empty command has no targets");

// ------------------------------------------------ cd is tracked for later relative targets
{
  const targets = bashWriteTargets("cd src && echo x > out.txt", fx.wt);
  const redirect = targets.find((t) => t.path === "out.txt");
  assert(
    redirect?.cwd === path.join(fx.wt, "src"),
    "tracking: a redirect after `cd src` resolves against src",
  );
}

rmSync(fx.base, { recursive: true, force: true });
if (exit === 0) console.log("✓ all write-fence bash assertions passed");
process.exit(exit);
