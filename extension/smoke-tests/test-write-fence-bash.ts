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
  PI_ENSEMBLE_WRITE_REPO: fx.repo,
  PI_ENSEMBLE_WRITE_SCRATCH: fx.scratch,
});
if (!cfg) throw new Error("fixture config did not load");

/** The first target the command writes that the rule refuses, or undefined when all pass. */
function refusedTarget(command: string, cwd: string = fx.wt): string | undefined {
  for (const t of bashWriteTargets(command, cwd)) {
    const judged = judgeWrite(t.path, t.cwd, cfg, { linkedCommand: t.linkedCommand });
    if (t.opaque || !judged.ok) return t.path;
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
  [`git -C ${fx.repo} commit -m x`, "git -C a write subcommand at the repo root"],
  // #1655 adversarial A — a substitution in a path hides its target: opaque, so refused.
  [`echo x > $(echo ${REPO_BIN})/keep`, "a redirect whose path is a command substitution"],
  [`rm $(echo ${REPO_BIN})/keep`, "rm of a path built from a command substitution"],
  ["echo x > `echo /repo`/keep", "a redirect whose path is a backtick substitution"],
  // #1655 adversarial B — ANSI-C escapes decode to the path they name.
  ["echo x > $'\\x2e\\x2e/bin/keep'", "an ANSI-C escaped ../ climbing out of the root"],
  // #1655 adversarial C — ~user and ~- are not expanded; refused as opaque.
  ["echo x > ~root/keep", "a redirect to ~user, which the fence cannot resolve"],
  ["echo x > ~-/keep", "a redirect to ~-, which the fence cannot resolve"],
  ["echo x > ~+/../bin/keep", "~+ is the working directory, so ~+/../bin escapes the root"],
  // A variable in a write target is opaque: its value is unknown when the command is judged.
  ["echo x > $OUT/keep", "a redirect through a variable"],
  ['echo x > "$OUT"', "a quoted redirect through a variable"],
  // #1655 MEDIUM 2 — a link the command creates, or overwrites, under a later path.
  [
    "ln -s /repo/bin x && echo y > x/new",
    "a write under a link created earlier in the same command",
  ],
  [
    "ln -sfn /tmp out && echo y > out/keep",
    "a write under an existing worktree link the command overwrites",
  ],
  // #1655 MEDIUM 3 — writers the fence now covers.
  [`dd if=/dev/zero of=${REPO_BIN}/keep bs=1 count=1`, "dd of= into the repo root"],
  [`truncate -s 0 ${REPO_BIN}/keep`, "truncate into the repo root"],
  [`chmod 600 ${REPO_BIN}/keep`, "chmod of a repo-root file"],
  [`chown root ${REPO_BIN}/keep`, "chown of a repo-root file"],
  [`curl -o ${REPO_BIN}/keep https://example.com/x`, "curl -o into the repo root"],
  [`wget -O ${REPO_BIN}/keep https://example.com/x`, "wget -O into the repo root"],
  [`tar -xf a.tgz -C ${REPO_BIN}`, "tar extraction into the repo root"],
  [`unzip a.zip -d ${REPO_BIN}`, "unzip -d into the repo root"],
  [`find ${REPO_BIN} -delete`, "find -delete under the repo root"],
  [`find . -name x -fprint ${REPO_BIN}/out`, "find -fprint into the repo root"],
  [`sort -o ${REPO_BIN}/keep x`, "sort -o into the repo root"],
  [`go build -o ${REPO_BIN}/bin ./cmd`, "go build -o into the repo root"],
  [`git config --file ${REPO_BIN}/cfg user.name x`, "git config --file into the repo root"],
  [`git clone x ${REPO_BIN}/c`, "git clone into the repo root"],
  [`rsync -a src/ ${REPO_BIN}/`, "rsync into the repo root"],
  ["cd " + fx.repo + " && tar -xf a.tgz", "a relative tar extraction after cd to the repo root"],
  // #1655 MEDIUM 4 — a command that does not lex is refused whole.
  [`echo "unterminated > ${REPO_BIN}/x`, "an unterminated quote is unparseable, so refused"],
  [
    `echo $'unterminated > ${REPO_BIN}/x`,
    "an unterminated ANSI-C string is unparseable, so refused",
  ],
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
  // #1655 review r1 — a subshell's cd does not end with the subshell.
  ["(cd src); echo x > ../../other/f", "a subshell cd does not carry a `..` write out of the root"],
  ["(cd src); echo x > ../x", "a subshell cd does not carry a `..` write to a sibling"],
  // Keywords and wrappers in front of the command name.
  [`if true; then rm ${REPO_BIN}/keep; fi`, "rm after `then`"],
  [`for f in x; do touch ${REPO_BIN}/$f; done`, "touch after `do`"],
  [`{ rm ${REPO_BIN}/keep; }`, "rm inside a brace group"],
  [`timeout 5 cp a ${REPO_BIN}/b`, "cp behind timeout and its duration"],
  [`nice -n 5 tee ${REPO_BIN}/x`, "tee behind nice -n"],
  [`xargs cp a ${REPO_BIN}/b`, "cp behind xargs"],
  [`env -C ${fx.repo} touch x`, "a relative touch after env -C into the repo root"],
  // Hard links: the new name shares the source's inode.
  ["ln ../../bin/keep k", "a hard link to a file outside the root"],
  ["cp -l ../../bin/keep k", "cp -l hard link to a file outside the root"],
  ["link ../../bin/keep k", "link(2) hard link to a file outside the root"],
  // A link created in the same call, written under its name.
  ["ln -s src lnk && echo x > lnk/f", "a write under a symlink created in the same command"],
  ["cp -R out copy2 && echo x > copy2/keep", "a write under a copied link, same command"],
  // #1655 review r2 — brace expansion is refused, not expanded.
  ["echo x > {../..,src}/x", "a brace list whose first branch climbs out of the root"],
  [`cp a {${REPO_BIN},src}/b`, "a brace list naming the repo root"],
  ["touch ../../{bin,src}/x", "a brace list after a climbing prefix"],
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
  ["ln -s src lnk", "a symlink created in the worktree (its name is not written through)"],
  [
    "cp -r src copy3",
    "a recursive copy into a new directory (the new name is not written through)",
  ],
  // #1655 D — a read-only git subcommand writes nothing, wherever -C points.
  [`git -C ${fx.repo} status`, "git -C at the repo root, read-only subcommand"],
  [`git -C ${fx.repo} log --oneline`, "git -C at the repo root, log"],
  // #1655 MEDIUM 3 — the same writers inside the worktree pass.
  ["dd if=/dev/zero of=out.bin bs=1 count=1", "dd of= inside the worktree"],
  ["truncate -s 0 out.txt", "truncate inside the worktree"],
  ["chmod 600 src/a.ts", "chmod inside the worktree"],
  ["curl -o out.json https://example.com/x", "curl -o inside the worktree"],
  ["tar -czf out.tgz src", "tar creating an archive writes nothing"],
  ["unzip -l a.zip", "unzip listing writes nothing"],
  ["find src -name '*.ts'", "find without -delete writes nothing"],
  ["sort -o out.txt in.txt", "sort -o inside the worktree"],
  ["go build ./...", "go build without -o writes nothing the fence names"],
  // #1655 A — a substitution in the body of a command, with the target inside the worktree.
  ["echo $(date) > out.txt", "a substitution in the body, the target inside the worktree"],
  // #1655 B — an ANSI-C escape that names a path inside the worktree.
  ["echo x > $'out\\x2etxt'", "an ANSI-C escaped name inside the worktree"],
  ["echo x > $'out\\u002etxt'", "an ANSI-C \\u escape inside the worktree"],
  // #1655 MEDIUM 4 — a command that lexes but is not a known writer is allowed: no write is named.
  [`frobnicate ${REPO_BIN}/keep`, "an unknown command name is parseable, so it is not refused"],
];
for (const [command, why] of allowedForms) {
  assert(refusedTarget(command) === undefined, `allow: ${why} — \`${command}\``);
}

// ------------------------------------------------ #1655 review r3 — globs at a write position
const globRefused: Array<[string, string]> = [
  ["echo x > o*/keep", "a glob in a redirect target, which may name the escaping link"],
  [`rm ${REPO_BIN}/k?ep`, "rm of a glob in a repo-root name"],
  ["cp a out/[k]eep", "a bracket glob naming a file through a link"],
  [`cp a ${REPO_BIN}/*`, "cp to a glob in the repo root"],
];
for (const [command, why] of globRefused) {
  assert(refusedTarget(command) !== undefined, `refuse: ${why} — \`${command}\``);
}
for (const [command, why] of [
  ["ls src/*.ts", "a glob in a read-only command writes nothing"],
  ["cat src/*", "a glob read by cat writes nothing"],
  ['echo "o*/keep" > out.txt', "a quoted glob is literal, and the target is inside the worktree"],
] as const) {
  assert(refusedTarget(command) === undefined, `allow: ${why} — \`${command}\``);
}

// ------------------------------------------------ #1655 review r3 — git output options
const gitOutputRefused: Array<[string, string]> = [
  [`git diff --output=${REPO_BIN}/patch`, "git diff --output= into the repo root"],
  [`git log --output ${REPO_BIN}/patch`, "git log --output with its value as the next word"],
  ["git show --output=../../bin/p", "git show --output= climbing out of the root"],
  [`git -C ${fx.repo} diff --output patch`, "git diff --output named relative to a -C at the repo root"],
  [`git format-patch -o ${REPO_BIN} HEAD~1`, "git format-patch -o into the repo root"],
  [`git format-patch --output-directory=${REPO_BIN} HEAD~1`, "git format-patch --output-directory="],
  [`git archive -o ${REPO_BIN}/a.tar HEAD`, "git archive -o into the repo root"],
  [`git bundle create ${REPO_BIN}/b HEAD`, "git bundle create into the repo root"],
  [`git -C ${fx.repo} format-patch -o out HEAD~1`, "format-patch -o relative to a -C outside the worktree"],
];
for (const [command, why] of gitOutputRefused) {
  assert(refusedTarget(command) !== undefined, `refuse: ${why} — \`${command}\``);
}
for (const [command, why] of [
  ["git diff --output=patch.diff", "git diff --output= inside the worktree"],
  ["git -C . log --output out.txt", "git log --output relative to a -C inside the worktree"],
  ["git diff --stat", "git diff without an output option writes nothing"],
  ["git archive HEAD", "git archive to stdout writes nothing"],
  ["git bundle verify src/x.bundle", "git bundle verify reads its file"],
] as const) {
  assert(refusedTarget(command) === undefined, `allow: ${why} — \`${command}\``);
}

// ------------------------------------------------ #1655 review r3 — command strings the shell runs
const bodyRefused: Array<[string, string]> = [
  [`sh -c 'echo x > ${REPO_BIN}/x'`, "a literal body handed to sh -c is read as a command"],
  [`bash -c 'rm ${REPO_BIN}/keep'`, "a literal body handed to bash -c"],
  [`zsh -lc 'echo x > ${REPO_BIN}/x'`, "a body behind a combined -lc flag"],
  [`eval 'echo x > ${REPO_BIN}/x'`, "a literal eval body"],
  [`eval rm ${REPO_BIN}/keep`, "an eval whose words join into a write"],
  [`sh -c 'echo x > ../../bin/x'`, "a body that climbs out of the root"],
  ['sh -c "$CMD"', "a body built at run time cannot be read, so it is refused"],
  ['eval "$CMD"', "an eval of a run-time string is refused"],
];
for (const [command, why] of bodyRefused) {
  assert(refusedTarget(command) !== undefined, `refuse: ${why} — \`${command}\``);
}
assert(
  refusedTarget(`sh -c 'echo x > out.txt'`) === undefined,
  "allow: a literal sh -c body whose target is inside the worktree",
);

// ------------------------------------------------ the best-effort line
assert(
  refusedTarget(`python -c 'open("${REPO_BIN}/x", "w")'`) === undefined,
  "documented gap: a non-shell interpreter one-liner is not read (listed in troubleshooting.md)",
);
assert(
  bashWriteTargets(`echo "unterminated > ${REPO_BIN}/x`, fx.wt)[0]?.opaque?.includes(
    "unparseable bash; refused by the write fence",
  ) === true,
  "fail-closed: a command that does not lex is refused with the unparseable reason",
);
assert(
  refusedTarget("cd -") === undefined,
  "best-effort: `cd -` (OLDPWD is not known statically) is not judged",
);
assert(refusedTarget("") === undefined, "an empty command has no targets");

// ------------------------------------------------ cd is tracked for later relative targets
{
  const targets = bashWriteTargets("cd src && echo x > out.txt", fx.wt);
  assert(
    targets.some((t) => t.path === "out.txt" && t.cwd === path.join(fx.wt, "src")),
    "tracking: a redirect after `cd src` is judged from src",
  );
  assert(
    targets.every((t) => t.linkedCommand === false),
    "tracking: a command that creates no link is never flagged linked",
  );
  const sub = bashWriteTargets("(cd src); echo x > out.txt", fx.wt);
  assert(
    sub.some((t) => t.path === "out.txt" && t.cwd === fx.wt) &&
      sub.some((t) => t.path === "out.txt" && t.cwd === path.join(fx.wt, "src")),
    "tracking: after a subshell cd the redirect is judged from both the start and src",
  );
}

rmSync(fx.base, { recursive: true, force: true });
if (exit === 0) console.log("✓ all write-fence bash assertions passed");
process.exit(exit);
