/**
 * test-hygiene-refspec-reader.ts — `pushRefspecs` and the deletion forms of the
 * push scan (#1788 round 2), split out of `test-public-hygiene-push.ts` along
 * the seam of one mechanism per file (AGENTS.md §12: split, never compress).
 *
 * The pure half asks the reader what it read out of a word list; the git half
 * runs the same commands through `scanPushRange` / `inspectCommand` against a
 * real temp repository, because a parser can be right about the words and still
 * wrong about what a push publishes (a deletion resolves nothing and must
 * refuse nothing). The push verb is assembled from fragments: the harness that
 * runs the offline suite guards a child's publish verbs by reading the command
 * string. Terms are synthetic and the denylist is always a temp file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { readPublicDenylist, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  inspectCommand,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { pushRefspecs, refspecSource, scanPushRange } from "../src/public-hygiene-push.ts";
import { PUSH_SCAN_MAX_BUFFER, PUSH_SCAN_TIMEOUT_MS } from "../src/public-hygiene-scan.ts";
import type { ExecFn } from "../src/worktree.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const GITHUB_REMOTE_URL = "https://github.com/example-owner/example-repo.git";
const PUSH = ["pu", "sh"].join("");
const pushCommand = (rest = "origin main"): string => ["git", PUSH, rest].join(" ").trim();
const scanOpts = (command: string): { command: string; pushVerb: string } => ({
  command,
  pushVerb: PUSH,
});

const root = mkdtempSync(path.join(tmpdir(), "hygiene-rdr-"));
const repo = path.join(root, "work");
const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# comment\n${TERM}\n`, "utf8");
const gitEnv = gitTestEnv();
/** What a SHELL-form call answers with, keyed on its program word. */
let shellScript: Record<string, { stdout?: string; error?: boolean }> = {};
/** When set, the scan's `git log` argv call fails — the one shape the
 *  scripted shell form cannot force, because the scan reaches git through the
 *  argv seam and never through a shell. */
let failLog = false;

function gitTransport(cwd: string): ExecFn {
  return (cmd, opts) =>
    execp(cmd, {
      argv: opts?.argv,
      cwd: opts?.cwd ?? cwd,
      timeout: opts?.timeout ?? PUSH_SCAN_TIMEOUT_MS,
      maxBuffer: opts?.maxBuffer ?? PUSH_SCAN_MAX_BUFFER,
      env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
    }) as Promise<{ stdout: string }>;
}

/**
 * The executor the scan is handed. argv calls — every call the scan itself
 * makes — run git in the temp repo. The SHELL form is answered from
 * `shellScript` and never run for real: a push would reach the network, and the
 * scan assembles its verb from fragments because this harness guards a child's
 * publish verbs by reading the command string.
 *
 * The script is keyed on the PROGRAM word, not matched as a substring: the
 * scan's own argv call is `git ["push", "origin", …]`, whose command string is
 * `git push`, so a needle that matched the verb answered the scan's `git
 * remote` from the script instead of from the repository, and a scan that was
 * meant to read the repo reported a clone with no remote. An unscripted shell
 * form falls through to the real executor, so only the push is intercepted.
 */
const exec: ExecFn = (cmd, opts) => {
  if (!opts?.argv) {
    const scripted = shellScript[cmd.split(/\s+/).find((w) => !w.startsWith("-")) ?? ""];
    if (scripted !== undefined) {
      if (scripted.error) {
        const e = new Error("scripted publish failure") as Error & { code?: string };
        e.code = "1";
        return Promise.reject(e);
      }
      return Promise.resolve({ stdout: scripted.stdout ?? "", stderr: "" });
    }
  } else if (failLog && cmd === "git" && opts.argv[0] === "log") {
    const e = new Error("scripted log failure") as Error & { code?: string };
    e.code = "128";
    return Promise.reject(e);
  }
  return gitTransport(repo)(cmd, opts) as Promise<{ stdout: string }>;
};
const git = (...args: string[]): Promise<string> =>
  (gitTransport(repo)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);
const gitIn =
  (cwd: string) =>
  (...args: string[]): Promise<string> =>
    (gitTransport(cwd)("git", { argv: args }) as Promise<{ stdout: string }>).then((r) => r.stdout);

const githubUrl = async (_remote: string): Promise<string> => GITHUB_REMOTE_URL;

function inspect(command: string) {
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  const env = { ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: denylist } as NodeJS.ProcessEnv;
  return inspectCommand(command, repo, exec, () => readPublicDenylist(env), {
    remoteUrl: githubUrl,
  });
}

await gitIn(root)("init", "-q", "--bare", "origin.git");
await gitIn(root)("clone", "-q", path.join(root, "origin.git"), "work");
await git("config", "user.email", "t@example.invalid");
await git("config", "user.name", "tester");
await git("branch", "-m", "main");
await git("remote", "set-url", "origin", GITHUB_REMOTE_URL);
writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
await git("add", "a.txt");
await git("commit", "-q", "-m", "chore: seed the repository");
const baseSha = (await git("rev-parse", "HEAD")).trim();
await git("update-ref", "refs/remotes/origin/main", baseSha);
await git("update-ref", "refs/remotes/origin/HEAD", baseSha);

async function reset(): Promise<void> {
  await git("reset", "-q", "--hard", baseSha);
  await git("update-ref", "refs/remotes/origin/main", baseSha);
  // Clear every branch and tag the selector cases create: a case that leaves a
  // dirty branch behind makes the NEXT case's `--all`/`--branches`/`--mirror`
  // range non-empty for the wrong reason, and a case that leaves a tag behind
  // does the same to `--tags`. Each case then states its own dirtiness.
  const branches = (await git("branch", "--format=%(refname:short)")).split("\n").filter(Boolean);
  for (const b of branches) {
    if (b !== "main") await git("branch", "-D", b).catch(() => {});
  }
  const tags = (await git("tag", "--list")).split("\n").filter(Boolean);
  for (const t of tags) await git("tag", "-d", t).catch(() => {});
}

// ── 15. The refspec reader itself: options dropped, option values swallowed,
// selectors recognised.
{
  const remotes = new Set(["origin"]);
  const a = pushRefspecs([PUSH, "origin", "main", "--force-with-lease", "topic"], PUSH, remotes);
  assert(
    a.refspecs.join(",") === "main,topic" && !a.branches && !a.tags,
    "positional args after the remote are refspecs and flags are dropped",
  );
  const b = pushRefspecs(["--no-verify", PUSH, "--all", "origin"], PUSH, remotes);
  assert(b.branches && b.refspecs.length === 0, "--all before the remote still means all branches");
  const c = pushRefspecs([PUSH, "origin", "--tags", "v1.2.3"], PUSH, remotes);
  assert(c.tags && c.refspecs.join() === "v1.2.3", "--tags is a selector, not a refspec");
  const d = pushRefspecs([PUSH, "origin", "+topic:refs/heads/topic"], PUSH, remotes);
  assert(d.refspecs.join() === "+topic:refs/heads/topic", "a forced refspec is kept verbatim");
  const e = pushRefspecs([PUSH, "origin", ":refs/heads/gone"], PUSH, remotes);
  assert(e.refspecs.join() === ":refs/heads/gone", "a deletion refspec reaches the source strip");
  // An option whose value is a SEPARATE word swallows its operand: `ci.skip`
  // is `-o`'s value, not a branch, and a scan that resolved it would refuse a
  // routine `push -o ci.skip` for a revision nobody named. `--force-with-lease`
  // is the opposite case and is kept here for the contrast: git reads its value
  // ONLY in the `=`-attached form, so the bare word after it is a refspec and
  // must stay one — dropping it would let a dirty `topic` out unscanned.
  const f = pushRefspecs([PUSH, "origin", "main", "-o", "ci.skip"], PUSH, remotes);
  assert(
    f.refspecs.join() === "main" && !f.deletes,
    "an option value given as a separate word is not a refspec",
  );
  const g = pushRefspecs([PUSH, "--repo", "origin2", "origin", "main"], PUSH, remotes);
  assert(
    g.refspecs.join() === "main",
    "--repo names a remote as its VALUE, so the anchor is the next bare word",
  );
  const h = pushRefspecs([PUSH, "origin", "main", "--force-with-lease", "topic"], PUSH, remotes);
  assert(
    h.refspecs.join() === "main,topic",
    "--force-with-lease takes a value only with `=`, so its follower stays a refspec",
  );
  // The deletion switches are the other way to ask for a deletion, and a
  // parser must not read the branch they name as a revision: `git push origin
  // --delete gone` reads `gone` as a ref name in a position git itself reads
  // after the option, so the words after a deletion switch are scanned the
  // same way whether or not the scan later treats them as commits.
  for (const [flag, rest] of [
    ["--delete", "origin --delete gone"],
    ["-d", "-d origin x"],
  ] as const) {
    const words = [PUSH, ...rest.split(/\s+/)];
    assert(
      pushRefspecs(words, PUSH, new Set(["origin"])).deletes,
      `pushRefspecs marks a push with ${flag} as a deletion`,
    );
  }
  // A delete publishes no commit, so the scan must resolve nothing and refuse
  // nothing: an implementation that tried to resolve the empty source would
  // fail closed on a routine branch deletion.
  await reset();
  const del = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand("origin :refs/heads/never-existed")),
  });
  assert(
    del.scanned && del.problems.length === 0 && del.texts.length === 0,
    "a deletion refspec publishes no commits and is not refused",
  );
  // The `-d`/`--delete` switches are the other way to ask for a deletion, and
  // the branch named there usually no longer exists — resolving it would be a
  // refusal about a push that publishes nothing.
  for (const flag of ["--delete", "-d"]) {
    const rest = flag === "--delete" ? "origin --delete gone" : "-d origin x";
    const scan = await scanPushRange({
      exec,
      cwd: repo,
      remoteUrl: githubUrl,
      ...scanOpts(pushCommand(rest)),
    });
    assert(
      scan.scanned && scan.texts.length === 0 && scan.problems.length === 0,
      `a push with ${flag} is scanned clean and refuses nothing`,
    );
    assert(
      (await inspect(pushCommand(rest))) === undefined,
      `a push with ${flag} of a branch that does not exist is allowed`,
    );
  }
  // `--delete` TOGETHER with a selector is the shape the short-circuit must
  // not swallow. Git's own rules, cited because the scan has to agree with them:
  // under `--delete` EVERY listed ref is deleted — the option is the same as a
  // leading colon on each refspec, so `origin --delete gone --all` deletes BOTH
  // `gone` and every branch — and git REFUSES to combine `--delete` with
  // `--all`/`--branches`/`--mirror`/`--tags`. That refusal makes the scan free:
  // the command publishes nothing either way, so scanning can only ever refuse
  // what was never going out, while short-circuiting on `--delete` lets a dirty
  // branch sit behind a flag nobody has typed yet.
  //
  // The operands under a selector are therefore READ AS DELETIONS — the colon
  // form, which resolves to a commit and publishes none (`refs/heads/gone` does
  // not have to exist for a deletion to be legal). Resolving `gone` as a
  // revision instead would refuse `push origin --delete gone --all` for a name
  // that is absent by definition, and skipping the operand entirely would scan
  // the selector and throw away the half of the command git also deletes.
  const DEL_SELECTOR_COMMAND = pushCommand("origin --delete gone --all");
  {
    const parsed = pushRefspecs(DEL_SELECTOR_COMMAND.split(/\s+/), PUSH, new Set(["origin"]));
    assert(
      parsed.deletes && parsed.branches && parsed.refspecs.join() === "gone",
      "the reader keeps the --delete operand and the selector side by side",
    );
    assert(
      refspecSource(parsed.refspecs[0] ?? "") === "gone" && refspecSource(":x/y") === "",
      "refspecSource strips the colon of a deletion, which is what makes one delete no commits",
    );
  }
  // A local branch that carries TERM in one of its commits and is NOT yet on a
  // remote-tracking ref: the only way to tell "the selector was scanned and the
  // range came back clean" from "nothing was read at all". The term goes in the
  // COMMIT MESSAGE, not the file: added diff lines are checked against the
  // private denylist only (the module header's tier split), so a term that
  // appears solely in a file body is not a hit and the assertion below would be
  // judging a clean range rather than a refused one.
  async function dirtyLocalBranch(name: string): Promise<void> {
    await git("checkout", "-q", "-b", name, baseSha);
    writeFileSync(path.join(repo, `d-${name}.txt`), "a note\n", "utf8");
    await git("add", `d-${name}.txt`);
    await git("commit", "-q", "-m", `chore: add the ${name} notes about ${TERM}`);
    await git("checkout", "-q", "main");
  }
  // The push is scripted, never run: this harness guards a child's publish
  // verbs by reading the command string, and a real publish would reach the
  // network — which would also delete the refs later cases depend on. Every
  // shell-form call in this section is answered from `shellScript`, so nothing
  // here touches a remote.
  shellScript = { [PUSH]: { stdout: "ok\n" } };
  for (const selector of ["--all", "--branches", "--mirror", "--tags"]) {
    await reset();
    await dirtyLocalBranch(`dl-${selector.replace(/[^a-z]/g, "")}`);
    // The scan reads the refs as they are when it is asked, so the tag must
    // exist before the scan rather than after it.
    if (selector === "--tags") {
      const dirty = (await git("rev-parse", `dl-${selector.replace(/[^a-z]/g, "")}`)).trim();
      await git("update-ref", "refs/tags/dirty-tag", dirty);
    }
    const command = pushCommand(`origin --delete gone ${selector}`);
    const scan = await scanPushRange({
      exec,
      cwd: repo,
      remoteUrl: githubUrl,
      ...scanOpts(command),
    });
    assert(
      scan.scanned && scan.problems.length === 0 && scan.texts.some((t) => t.text.includes(TERM)),
      `--delete with ${selector} still scans the selector rather than short-circuiting`,
    );
    // The push itself is scripted, never run: this harness guards a child's
    // publish verbs by reading the command string, and a real publish would
    // reach the network. The scan has already read its range through the argv
    // seam by the time `inspect` builds the command, so the verdict is settled
    // before the scripted push is answered.
    const decision = await inspect(command);
    assert(
      decision !== undefined && decision.reason.includes("private-denylist entry matched"),
      `--delete with ${selector} is refused on the dirty branch it names`,
    );
    assert(
      String(decision?.reason ?? "").includes("denylist line"),
      `and the ${selector} refusal names the denylist line, not the term`,
    );
    assert(
      !String(decision?.reason ?? "").includes(TERM),
      `and the ${selector} refusal carries no term`,
    );
  }
  // The selector under `--delete` is not merely reached, it is what decides.
  // With every refspec a deletion (git's own reading of the option), an
  // implementation that short-circuited on the flag asked git nothing and
  // called the push clean. The log read is forced to fail through `failLog`
  // below — the scan asks git through the argv seam, so the only way to make a
  // specific read break is to break the seam for that one shape. The refusal
  // then names the read that failed, which can only happen if the selector
  // produced commits: no commits, no log call, no refusal at all.
  await reset();
  await dirtyLocalBranch("dl-forced");
  failLog = true;
  const forced = await inspect(pushCommand("origin --delete gone --branches"));
  failLog = false;
  assert(
    forced !== undefined && String(forced.reason).includes("outgoing commits could not be read"),
    "the selector under --delete really produces a range: the read that failed is named",
  );
  // And the same command with NOTHING unpublished is allowed: the selector is
  // read, the range comes back empty, and a delete still publishes nothing.
  await reset();
  shellScript = { [PUSH]: { stdout: "ok\n" } };
  const cleanDelete = await inspect(pushCommand("origin --delete gone --branches"));
  shellScript = {};
  assert(
    cleanDelete === undefined,
    "the same command is allowed when nothing the selector lists is dirty",
  );
  // `--delete` WITH an operand is not a bare push: git reads `gone` as the ref
  // to delete, so nothing publishes. An implementation that asked "was any
  // refspec named?" after handling the delete would fall through to HEAD and
  // scan commits this push does not publish — a real range read as if it were
  // the outgoing one.
  await reset();
  await dirtyLocalBranch("dl-head");
  const deleteWithOperand = await scanPushRange({
    exec,
    cwd: repo,
    remoteUrl: githubUrl,
    ...scanOpts(pushCommand("origin --delete gone")),
  });
  assert(
    deleteWithOperand.scanned &&
      deleteWithOperand.texts.length === 0 &&
      deleteWithOperand.problems.length === 0,
    "--delete with an operand publishes nothing and does not fall through to HEAD",
  );
  assert(
    (await inspect(pushCommand("origin --delete gone"))) === undefined,
    "the same command is allowed while HEAD is dirty — a delete publishes nothing",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
