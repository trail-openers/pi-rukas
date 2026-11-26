#!/usr/bin/env bun
/**
 * test-child-forge-read-guard.ts — the #2638 rule: a helper child cannot read the
 * operator's forge config directories, whatever its own environment says.
 *
 * Every row drives the REAL `tool_call` hook (`registerForgeReadGuard`) against a
 * fixture home of FAKE config files (`lib/forge-read-protected-fixture.ts`) — no
 * real credential file is opened anywhere in this file. The rows are the six read
 * forms the issue names, for BOTH forges:
 *
 *   A  `cat` / `head` / `tail` / `grep` / `strings` / `base64` of a config file,
 *      and an input REDIRECT (`<`) — the two shapes a shell uses to read;
 *   B  a copy (`cp`, `install`, `tar`, `rsync`, `dd`) — read-side operands, which
 *      the write fence's copy reader does not judge at all;
 *   C  a `read` TOOL call (and a codemode-routed one, carrying `parentToolCallId`);
 *   D  an env RE-POINT or UNSET — the field report's own move — which changes
 *      nothing, because the protected set is harness-owned data (decision 4);
 *   E  a SYMLINK onto a protected directory, in either direction (a link named
 *      innocently, and a link whose target is spelled);
 *   F  the pass arms: paths that are not forge configs still run, so the rule is
 *      a rule and not a refusal of everything;
 *   F2 the shapes a judge that only reads argv words lets through — a heredoc
 *      body, an interpreter's positional program, an option value, a `cd` /
 *      `git -C` that moves the cwd, a case-shifted directory name, a `file://`
 *      URL, an archive of a PARENT directory, a `~` under a redirected scratch
 *      home, and a bare `<` redirect with no protected set at all;
 *   G  ops exemption, and the missing-role arm (fails closed, decision 12);
 *   H  the passwd-home canary: a path the fixture's env never named, which only
 *      the parent's passwd entry produces — the row that proves the guard judged a
 *      path OUTSIDE the fixture home (decision 14);
 *   I  the mutant: the same rows with the hook stand-down, each observed RED.
 *
 * Env pins go through `withEnv`, which restores exactly what was there (including
 * an absent variable), so nothing leaks into the next test file.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registerForgeReadGuard } from "../src/child-forge-read-guard.ts";
import { FORGE_PROTECTED_PATHS_ENV } from "../src/child-forge-read-roots.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";
import { runBypassSection } from "./lib/forge-read-guard-bypasses.ts";
import {
  type Row,
  dirsFor,
  expectAllowed,
  expectRefused,
  homesFor,
  isCommand,
  judge,
} from "./lib/forge-read-guard-driver.ts";
import { dispatch, makeFakePi } from "./lib/forge-read-guard-harness.ts";
import {
  GH_TOKEN_SENTINEL,
  GLAB_TOKEN_SENTINEL,
  buildForgeFixture,
  childForgeDirUnder,
  forgeParentEnv,
} from "./lib/forge-read-protected-fixture.ts";

// ============================================================
// A — reads of each config file, for both forges.
// ============================================================
{
  const fx = buildForgeFixture("reads");
  const env = forgeParentEnv(fx);
  const dirs = dirsFor(env, fx.passwdHome);
  assert(dirs.length >= 2, `A: the parent resolved the gh and glab roots (${dirs.length})`);
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;

  const readers = [
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "grep token",
    "strings",
    "base64",
    "xxd",
    "od",
    "awk",
    "sed",
  ];
  for (const reader of readers) {
    await expectRefused(
      `${reader} ${ghFile}`,
      dirs,
      `A/gh \`${reader}\``,
      "a judged read verb names the credential file",
    );
  }
  await expectRefused(
    `cat ${glabFile}`,
    dirs,
    "A/glab `cat`",
    "the glab credential file is judged too",
  );
  await expectRefused(
    `cat ${fx.glab}/config.yml`,
    dirs,
    "A/glab config.yml",
    "glab's config file under the resolved glab root",
  );
  // The redirect form: the shell, not a reader, opens the file.
  await expectRefused(`sh < ${ghFile}`, dirs, "A/redirect", "an input redirect reads the file");
  await expectRefused(
    `while read -r l; do echo $l; done < ${glabFile}`,
    dirs,
    "A/redirect-loop",
    "a loop whose redirect is the credential file",
  );
  // The directory itself, not one file: `ls`, `du`, a glob.
  await expectRefused(
    `ls ${fx.gh}`,
    dirs,
    "A/ls dir",
    "listing the config directory is a read of it",
  );
  await expectRefused(`du -sh ${fx.glab}`, dirs, "A/du dir", "the glab root by name");
  await expectRefused(`cat ${fx.gh}/*`, dirs, "A/glob", "a glob under the protected root");
  // An unknown command naming the path is refused too (decision 6: unknown means refused).
  await expectRefused(
    `somebody-elses-tool ${ghFile}`,
    dirs,
    "A/unknown command",
    "an unrecognised command naming a protected path is refused, not passed",
  );
  // A read behind a wrapper is the same read.
  await expectRefused(
    `env -u GLAB_CONFIG_DIR cat ${glabFile}`,
    dirs,
    "A/env -u",
    "a reader behind `env -u` is still that reader",
  );
  await expectRefused(
    `sudo -u root cat ${ghFile}`,
    dirs,
    "A/sudo",
    "a reader behind `sudo` is still that reader",
  );
  // An interpreter with inline code (decision 6).
  await expectRefused(
    `python3 -c 'print(open("${ghFile}").read())'`,
    dirs,
    "A/python -c",
    "an interpreter's inline code names the credential file",
  );
  await expectRefused(
    `node -e 'console.log(require("fs").readFileSync("${glabFile}","utf8"))'`,
    dirs,
    "A/node -e",
    "a node one-liner names the glab file",
  );
  // A chain and a pipeline: every segment is judged.
  await expectRefused(
    `echo start && cat ${ghFile}`,
    dirs,
    "A/chain",
    "a chained segment reads the credential file",
  );
  await expectRefused(
    `cat ${ghFile} | base64`,
    dirs,
    "A/pipeline",
    "the first segment of a pipeline reads it",
  );
  // The sentinel content is NEVER echoed into the reason.
  const r = await judge(`cat ${ghFile}`, dirs);
  assert(
    r?.block === true &&
      !(r.reason ?? "").includes(GH_TOKEN_SENTINEL) &&
      !(r.reason ?? "").includes(ghFile),
    "A: the refusal prints neither the token nor the path (the reason is disclosure-safe)",
  );
}

// ============================================================
// B — copies: the read-side operand, which the write fence never judged.
// ============================================================
{
  const fx = buildForgeFixture("copies");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;
  const out = "/tmp/child-out";
  const rows: Array<[Row, string]> = [
    [`cp ${ghFile} ${out}`, "cp reads the credential file"],
    [`cp -a ${fx.gh} ${out}`, "cp -a reads the whole gh root"],
    [`install -m 600 ${glabFile} ${out}`, "install reads the glab file"],
    [`tar czf ${out}.tgz -C ${fx.glab} .`, "tar reads the glab root"],
    [`rsync -a ${fx.gh}/ ${out}/`, "rsync reads the gh root"],
    [`dd if=${glabFile} of=${out}`, "dd's if= reads the glab file"],
    [`ln ${ghFile} ${out}`, "a hard link shares the credential's inode"],
    [`mv ${ghFile} ${out}`, "mv reads (and moves) the credential file"],
  ];
  for (const [row, why] of rows) {
    await expectRefused(row, dirs, `B/${isCommand(row) ? row.slice(0, 40) : "row"}`, why);
  }
}

// ============================================================
// C — the read TOOL, direct and codemode-routed.
// ============================================================
{
  const fx = buildForgeFixture("tools");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;
  await expectRefused(
    ["read", { path: ghFile }],
    dirs,
    "C/read tool gh",
    "the read tool names the credential file",
  );
  await expectRefused(["read", { path: glabFile }], dirs, "C/read tool glab", "…and the glab file");
  await expectRefused(
    ["read", { path: fx.gh }],
    dirs,
    "C/read tool dir",
    "the config directory itself",
  );
  await withEnv({ HOME: fx.home }, async () =>
    expectRefused(
      ["read", { path: "~/.config/gh/hosts.yml" }],
      dirs,
      "C/read tool tilde",
      "a `~/…` spelling expands against the home before judgement",
    ),
  );
  await expectRefused(
    ["read", { path: `@${ghFile}` }],
    dirs,
    "C/read tool @",
    "Pi's leading-@ spelling is judged as the same path",
  );
  // A codemode-routed call reaches the same hook: the hook reads the event, and
  // Pi's nested-call runner emits it with the same shape plus parentToolCallId.
  const fake = makeFakePi();
  await withEnv({ [FORGE_PROTECTED_PATHS_ENV]: dirs.map((d) => d.lexical).join(":") }, async () => {
    registerForgeReadGuard(fake as unknown as ExtensionAPI, { dirs, cwd: "/tmp" });
  });
  const nested = await dispatch(fake, {
    toolName: "read",
    input: { path: ghFile },
    parentToolCallId: "codemode-call-1",
  });
  assert(
    (nested as { block?: boolean })?.block === true,
    "C/codemode-routed: a read routed through a codemode script carries parentToolCallId and is refused by the same hook",
  );
  const nestedBash = await dispatch(fake, {
    toolName: "bash",
    input: { command: `cat ${glabFile}` },
    parentToolCallId: "codemode-call-1",
  });
  assert(
    (nestedBash as { block?: boolean })?.block === true,
    "C/codemode-routed bash: the same rule for a script's bash call",
  );
}

// ============================================================
// D — the field report's own move: re-point or unset the config-dir variable.
// ============================================================
{
  const fx = buildForgeFixture("env-repoint");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  // The child's env now lies: its own GH_CONFIG_DIR / GLAB_CONFIG_DIR point at an
  // empty dir of its own, and both names are then unset. The guard never asks.
  const childDir = childForgeDirUnder(fx.root);
  await withEnv(
    {
      GH_CONFIG_DIR: childDir,
      GLAB_CONFIG_DIR: childDir,
      HOME: childDir,
      XDG_CONFIG_HOME: childDir,
    },
    async () => {
      await expectRefused(
        `cat ${fx.ghFiles[1] as string}`,
        dirs,
        "D/child env lies",
        "the child re-pointed both config roots at its own empty dir",
      );
      // The move the field report made, in the command itself.
      await expectRefused(
        `unset GLAB_CONFIG_DIR; glab auth status; cat ${fx.glabFiles[0] as string}`,
        dirs,
        "D/unset GLAB_CONFIG_DIR",
        "unsetting the variable does not restore access",
      );
      await expectRefused(
        `GLAB_CONFIG_DIR=${childDir} cat ${fx.glabFiles[0] as string}`,
        dirs,
        "D/inline re-point",
        "a per-command assignment changes nothing the guard sees",
      );
      await expectRefused(
        `export GH_CONFIG_DIR=${childDir} && cat ${fx.ghFiles[1] as string}`,
        dirs,
        "D/export re-point",
        "an export changes nothing either",
      );
      const read = await judge(["read", { path: fx.glabFiles[0] as string }], dirs);
      assert(
        read?.block === true,
        "D/read tool under a lying env: still refused (the set is harness-owned data)",
      );
    },
  );
  // Controls for the fail-closed arms below, which must be refusals of THIS call and
  // not a blanket "nothing can be judged" that blocks every helper's every command.
  // With a real set, an ordinary path and an ordinary command both run.
  const withDirs = await judge(`cat ${path.join(fx.root, "notes.txt")}`, dirs);
  assert(withDirs === undefined, "D/control: with a real set, an ordinary path is allowed");
  const withDirsGh = await judge("gh pr view 5", dirs);
  assert(withDirsGh === undefined, "D/control: with a real set, `gh pr view 5` runs");
  // With NO set at all: a call that cannot name a forge config directory still runs
  // (the guard's absence is not a licence to break the child), and one that names a
  // config-dir SPELLING is refused, because nothing judged it and it may be the read.
  const ordinary = await judge(`cat ${path.join(fx.root, "notes.txt")}`, undefined);
  assert(ordinary === undefined, "D/control: with no set, an ordinary path still runs");
  const ghRead = await judge("gh pr view 5", undefined);
  assert(ghRead === undefined, "D/control: with no set, `gh pr view 5` still runs");
  const nearMiss = await judge("cat /tmp/ghost/haunted.md", undefined);
  assert(
    nearMiss === undefined,
    "D/control: `ghost` is not `gh` — a near-miss component is not a config dir",
  );
  const noSetButNames = await judge("cat /tmp/x/.config/gh/hosts.yml", undefined);
  assert(
    noSetButNames?.block === true,
    "D/control: with no set, a call naming a config-dir spelling is refused (fail-closed, and only for that)",
  );
  // The fail-closed arms: no set, or a malformed one, is a refusal, not a pass.
  const noSet = await judge(`cat ${fx.ghFiles[1] as string}`, undefined);
  assert(
    noSet?.block === true,
    "D/no protected set in the child's env: refused (silence is never a pass)",
  );
  // An EMPTY harness-owned set is the silent-death arm: the guard was handed a set
  // with no entries in it, which protects nothing. `[]` is injected directly, not
  // serialised, because an empty serialised value is the ABSENT case above.
  const emptySet = await judge(`cat ${fx.ghFiles[1] as string}`, [], { injected: [] });
  assert(
    emptySet?.block === true,
    "D/an EMPTY protected set handed to the hook: refused (a rule that protects nothing has silently stopped working)",
  );
  // A malformed serialised value is a set the child cannot trust. Driven through the
  // env the guard itself reads, with the judge's own set left absent.
  const bad = makeFakePi();
  await withEnv({ [FORGE_PROTECTED_PATHS_ENV]: "relative/gh:" }, async () => {
    registerForgeReadGuard(bad as unknown as ExtensionAPI, { cwd: "/tmp" });
  });
  const badVerdict = await dispatch(bad, {
    toolName: "bash",
    input: { command: `cat ${fx.ghFiles[1] as string}` },
  });
  assert(
    (badVerdict as { block?: boolean })?.block === true,
    "D/a malformed protected set (a relative entry): refused as a whole, never judged partially",
  );
  const good = makeFakePi();
  await withEnv({ [FORGE_PROTECTED_PATHS_ENV]: dirs.map((d) => d.lexical).join(":") }, async () => {
    registerForgeReadGuard(good as unknown as ExtensionAPI, { cwd: "/tmp" });
  });
  const goodVerdict = await dispatch(good, {
    toolName: "bash",
    input: { command: `cat ${fx.ghFiles[1] as string}` },
  });
  assert(
    (goodVerdict as { block?: boolean })?.block === true,
    "D/the serialised set alone carries the rule (no injected judge set): refused",
  );
}

// ============================================================
// E — symlinks, in both directions.
// ============================================================
{
  const fx = buildForgeFixture("symlinks");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  // (i) an innocent name whose target is a protected file.
  const linkIn = path.join(fx.root, "notes.txt");
  symlinkSync(fx.ghFiles[1] as string, linkIn);
  await expectRefused(
    `cat ${linkIn}`,
    dirs,
    "E/link to credential",
    "a symlink onto a protected file is refused",
  );
  await expectRefused(
    ["read", { path: linkIn }],
    dirs,
    "E/read via link",
    "the read tool through the same link",
  );
  // (ii) a link directory that resolves INTO the protected root.
  const linkDir = path.join(fx.root, "cfg");
  symlinkSync(fx.gh, linkDir);
  await expectRefused(
    `cat ${linkDir}/hosts.yml`,
    dirs,
    "E/link dir",
    "a path through a link into the root",
  );
  await expectRefused(
    `cat ${path.join(fx.root, "cfg", "hosts.yml")}`,
    dirs,
    "E/link dir (literal name)",
    "a LITERAL path under a name that is now a link into the root: the link is followed, not trusted",
  );
  // (iii) a symlink the child made AT a protected path, pointing away — the
  // snapshot/restore owns the write, and a read of that name still reads.
  const swapped = path.join(fx.root, "elsewhere.yml");
  writeFileSync(swapped, "innocent\n");
  const ghHosts = fx.ghFiles[1] as string;
  const { rmSync } = await import("node:fs");
  rmSync(ghHosts, { force: true });
  symlinkSync(swapped, ghHosts);
  await expectRefused(
    `cat ${ghHosts}`,
    dirs,
    "E/swapped link",
    "a link swapped in at the protected path is judged by its protected NAME",
  );
  // (iv) a relative link reached from the child's cwd — read through the
  // harness-owned absolute path, which is what `judge` above pins for every row.
  const cwdTree = path.join(fx.root, "wt");
  mkdirSync(cwdTree, { recursive: true });
  symlinkSync(fx.glabFiles[0] as string, path.join(cwdTree, "local.cfg"));
  const rel = await judge(["read", { path: path.join(cwdTree, "local.cfg") }], dirs, {
    cwd: cwdTree,
  });
  assert(
    rel?.block === true,
    "E/relative link: refused (a relative name inside the child's cwd resolves to the glab file)",
  );
}

// ============================================================
// F — the pass arms: the rule is a rule, not a refusal of everything.
// ============================================================
{
  const fx = buildForgeFixture("passes");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  const inTree = path.join(fx.root, "wt");
  mkdirSync(inTree, { recursive: true });
  writeFileSync(path.join(inTree, "notes.md"), "hello\n");
  const childDir = childForgeDirUnder(fx.root);
  const passes: Array<[Row, string]> = [
    [`cat ${path.join(inTree, "notes.md")}`, "an ordinary file in the child's tree"],
    [
      `cat ${childDir}/whatever`,
      "the child's OWN (empty) forge dir — the strip's target is not protected",
    ],
    ["cat package.json", "a relative read of a project file"],
    ["ls -la", "a listing of the cwd"],
    ["git status --porcelain", "the project's own status"],
    [`grep -rn TODO ${inTree}`, "a recursive search inside the tree"],
    ["gh pr view 5", "a gh read (the wrapper answers it, not this hook)"],
    [`echo hi > ${path.join(inTree, "x")}`, "an output redirect inside the tree"],
    [`cat ${fx.gh}-backup/config.yml`, "a name that merely shares the root's prefix"],
    ["cat /etc/passwd", "a system file that is no forge config"],
  ];
  for (const [row, why] of passes) {
    await expectAllowed(row, dirs, `F/${isCommand(row) ? row.slice(0, 34) : "read"}`, why);
  }
  const ok = await judge(["read", { path: path.join(inTree, "notes.md") }], dirs, { cwd: inTree });
  assert(ok === undefined, "F/read tool inside the tree: allowed");
}

// ============================================================
// F2 — the shapes an argv-only judge lets through (rows in
// `lib/forge-read-guard-bypasses.ts`, so the workarounds live apart from the
// forms above).
// ============================================================
await runBypassSection();

console.log(`\nexit ${exit}`);
process.exit(exit);
