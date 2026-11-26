/**
 * test-child-forge-read-guard-bypasses.ts — the F2 rows of the #2638 read rule,
 * kept in their own file so the suite's entry stays a table of the forms rather
 * than a list of the workarounds.
 *
 * Every row here was ALLOWED by the shipped judge when the reviewer drove it with
 * the parent-resolved set against a fixture operator home. Each is the same read
 * as a row in `test-child-forge-read-guard.ts`, spelled so the protected path
 * never appears as a bare argv word of a command the judge recognises — which is
 * exactly what makes it the same bug. Two halves, because they answer different
 * questions about the judge:
 *
 *   `bypassRows` — the command spellings: a heredoc body, an interpreter's
 *      positional or here-string program, an option value (`--file=`, `if=`, `-f`),
 *      the directory an earlier `cd` / `git -C` / `env -C` moved the command to, a
 *      case-shifted root, a `file://` URL, an archive or recursive copy of a PARENT
 *      of a protected root, and a `~` under a redirected scratch home.
 *   `noSetRows` — the fail-closed arm, asked with NO protected set: a bare `<`
 *      operand and a heredoc body, the two reads the argv-only pass judged nothing.
 *
 * The driver owns the fixture, the parent-resolved set, and the refusal assertion;
 * this file owns only the rows, so a new workaround is one row and not an edit to
 * the entry's control flow.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert } from "./assert-rig.ts";
import { withEnv } from "./env-scope.ts";
import {
  type Row,
  dirsFor,
  expectAllowed,
  expectRefused,
  homesFor,
  isCommand,
  judge,
} from "./forge-read-guard-driver.ts";
import {
  type ForgeFixture,
  buildForgeFixture,
  childForgeDirUnder,
  forgeParentEnv,
} from "./forge-read-protected-fixture.ts";

/** The command spellings that carry the read past an argv-word judge. */
export function bypassRows(fx: ForgeFixture): Array<[Row, string]> {
  const { home, xdg } = fx;
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;
  return [
    // (a) The heredoc body: the program a child hands an interpreter, with the
    // credential path inside it. Quoted and unquoted delimiters both, because the
    // quoting decides what the SHELL expands, not what the child wrote.
    [
      `python3 - << 'PY'\nprint(open("${ghFile}").read())\nPY`,
      "a python program in a quoted heredoc",
    ],
    [
      `python3 - << PY\nprint(open("${ghFile}").read())\nPY`,
      "a python program in an unquoted heredoc",
    ],
    [`bash << 'EOF'\ncat ${ghFile}\nEOF`, "a shell script in a quoted heredoc"],
    [`bash << EOF\ncat ${ghFile}\nEOF`, "a shell script in an unquoted heredoc"],
    [
      `sh - << 'SH'\nwhile read -r l; do echo "$l"; done < ${glabFile}\nSH`,
      "an input redirect inside a heredoc",
    ],
    // (b) An interpreter's program as a bare positional word — no `-c`, no `-e`,
    // so an option-letter rule never reaches the text that opens the file.
    [
      `awk 'BEGIN{while((getline l < "${ghFile}")>0) print l}'`,
      "awk's program opens the file by name",
    ],
    [`sed -n '1p' ${ghFile}`, "sed reads the file it names"],
    [`jq -r . ${ghFile}`, "jq reads the file it names"],
    [`lua -e 'print(io.open("${ghFile}"):read("*a"))'`, "lua's inline program"],
    [
      `tclsh <<< 'puts [exec cat ${ghFile}]'`,
      "an interpreter fed its program by here-string, which execs the reader",
    ],
    [`perl -e 'print slurp("${ghFile}")'`, "perl's inline program"],
    [`ruby -e 'puts File.read("${ghFile}")'`, "ruby's inline program"],
    [`deno eval 'Deno.readFile("${ghFile}")'`, "deno's eval program"],
    [`bun -e 'Deno.readFile("${ghFile}")'`, "bun's -e program"],
    [`bun run ${ghFile}`, "bun run of a script inside the config dir"],
    [
      `node -e 'console.log(require("fs").readFileSync("${glabFile}","utf8"))'`,
      "node's -e program",
    ],
    [`python -c 'open("${glabFile}").read()'`, "python's -c program"],
    // (c) Option values: the path is the value of an option, not a word of its own.
    [`jq --file=${ghFile} -n .`, "a path attached to `--file=`"],
    [`dd if=${ghFile} bs=1 count=1`, "dd's `if=` value"],
    [`sort -f${ghFile}`, "a path attached to a short option"],
    [
      `git -C ${home} config --file .config/gh/hosts.yml -l`,
      "a relative `--file` VALUE under `git -C` (git opens the file relative to its `-C` directory)",
    ],
    [
      `git -C ${home} config --file=.config/glab-cli/config.yml -l`,
      "the glab root reached through a relative `--file=` value",
    ],
    [`git -C ${home} config --file=.config/gh/hosts.yml -l`, "a relative --file= under `git -C`"],
    [`git -C ${home} cat-file -p .config/gh/hosts.yml`, "a relative operand under `git -C`"],
    [`env -C ${home} cat .config/gh/hosts.yml`, "a relative operand under `env -C`"],
    [`cd ${home} ; cat .config/gh/hosts.yml`, "a relative operand after `cd`"],
    [`(cd ${home}; cat .config/gh/hosts.yml)`, "a relative operand in a subshell after `cd`"],
    // (d) Case: the protected set is spelled in lower case by every resolver, and a
    // case-sensitive filesystem makes another spelling a different tree — so the
    // CASE-INSENSITIVE matcher must refuse the shifted spelling of a protected root
    // and still allow an unrelated directory that merely shares the name.
    [`cat ${path.join(fx.home, ".config/GH/hosts.yml")}`, "a case-shifted `GH` root"],
    [`cat ${path.join(fx.home, ".config/Glab-CLI/config.yml")}`, "a case-shifted `Glab-CLI` root"],
    [`cat ${path.join(fx.xdg, "GH", "hosts.yml")}`, "the XDG spelling shifted in case"],
    // (e) A `file://` URL: the path is inside the word, behind the scheme.
    [`curl file://${ghFile}`, "curl reading the credential file by URL"],
    [`wget file://${ghFile}`, "wget reading the credential file by URL"],
    // (f) An archive or recursive copy of a PARENT of the protected directory: no
    // protected path is named, and the credential bytes still leave the tree.
    [`tar czf /tmp/a.tgz ${path.join(fx.home, ".config")}`, "tar of the parent of both roots"],
    [`tar czf /tmp/x.tgz -C ${path.join(fx.home, ".config")} .`, "tar of the parent through -C"],
    [`cp -r ${path.join(fx.home, ".config")} /tmp/x`, "cp -r of the parent directory"],
    [`rsync -a ${path.join(fx.home, ".config")}/ /tmp/x/`, "rsync of the parent directory"],
    // (g) A `~` under a scratch home: a reviewer/explore child's HOME is a tree the
    // harness itself redirects, so the child's own home is not the one `~` means.
    [["read", { path: "~/.config/gh/hosts.yml" }], "the read tool under a redirected scratch HOME"],
  ];
}

/**
 * The reads the argv-only pass judged nothing, asked of the arm that has no
 * protected set at all: each must still be refused, because nothing judged it.
 */
export async function noSetRows(fx: ForgeFixture): Promise<void> {
  const env = forgeParentEnv(fx);
  const dirs = dirsFor(env, fx.passwdHome);
  const homes = homesFor(env, fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  const noSet = await judge(`cat < ${ghFile}`, undefined, { homes });
  assert(
    noSet?.block === true,
    "F2/h/no-set: `cat < <credential file>` with NO protected set is refused (the fail-closed arm sees `<` operands)",
  );
  const noSetBody = await judge(`bash << 'EOF'\ncat ${ghFile}\nEOF`, undefined, { homes });
  assert(
    noSetBody?.block === true,
    "F2/h/no-set: a heredoc body naming a config dir with NO protected set is refused too",
  );
  const noSetCase = await judge(`cat ${path.join(fx.home, ".config/GH/hosts.yml")}`, undefined, {
    homes,
  });
  assert(
    noSetCase?.block === true,
    "F2/h/no-set: the case-shifted spelling counts in the fail-closed predicate as well",
  );
}

/**
 * The F2 block, run as its own section of the entry: the rows, the two control
 * rows that keep them honest (a case-shifted directory that is no protected root
 * still reads; a `~` path that is no forge config still runs), and the scratch
 * `HOME` arm driven the way a reviewer child really runs.
 */
export async function runBypassSection(tag = "bypasses"): Promise<void> {
  const fx = buildForgeFixture(tag);
  const env = forgeParentEnv(fx);
  const dirs = dirsFor(env, fx.passwdHome);
  const homes = homesFor(env, fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;
  for (const [row, why] of bypassRows(fx)) {
    await expectRefused(row, dirs, `F2/${isCommand(row) ? row.slice(0, 44) : "read"}`, why, {
      homes,
    });
  }
  await noSetRows(fx);
  // (d) control: a directory that merely CARRIES a forge name, and is not one of
  // the protected roots, still reads — the case-insensitive matcher must widen to
  // the shifted spellings of the protected roots, not to every directory named `gh`.
  const unrelated = path.join(fx.root, "Gh", "notes.md");
  mkdirSync(path.dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, "hello\n");
  await expectAllowed(
    `cat ${unrelated}`,
    dirs,
    "F2/d/control",
    "a case-shifted directory that is no protected root still reads",
  );
  // (g) the scratch-home arm, driven the way a reviewer child really runs: HOME
  // redirected at a scratch tree, the operator's config where the parent said.
  const scratch = childForgeDirUnder(fx.root);
  await withEnv({ HOME: scratch, XDG_CONFIG_HOME: scratch }, async () => {
    await expectRefused(
      ["read", { path: "~/.config/gh/hosts.yml" }],
      dirs,
      "F2/g/scratch HOME read",
      "a `~` under a redirected scratch HOME still means the parent's home",
      { homes },
    );
    await expectRefused(
      "cat ~/.config/gh/hosts.yml",
      dirs,
      "F2/g/scratch HOME bash",
      "the same spelling through bash",
      { homes },
    );
    const ordinary = await judge(path.join("~", path.basename(fx.root), "notes.txt"), dirs, {
      homes,
    });
    assert(
      ordinary === undefined,
      "F2/g/control: a `~` path that is no forge config still runs under the scratch HOME",
    );
  });
}
