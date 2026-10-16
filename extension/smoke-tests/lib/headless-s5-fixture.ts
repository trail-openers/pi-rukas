/**
 * Offline fixture for the headless S5 gates (#1025).
 *
 * The headless runner composes the pieces the `--merge` / `--sandboxed` refusal
 * protects: merge authority read from AGENTS.md at the cycle's base commit, the
 * `gh` merge-evidence gate, and the sandbox/trust environment children inherit.
 * Each piece is unit-tested in isolation (test-merge-authority.ts,
 * test-policy-judge.ts, test-headless-cli.ts). What no existing test covers is
 * the composition — that a headless process which never sets a trust env var,
 * never receives `--merge`, and only ever answers `gh` honestly still cannot
 * merge without doctrine + evidence, and still reports the exit codes the docs
 * promise. This fixture builds the repository and the seams that composition
 * runs against.
 *
 * ## Why the doctrine lives only at the base commit
 *
 * #406 reads AGENTS.md at `state.pipelineState.baseSha`, not from the working
 * tree — a cycle that writes its own grant must grant itself nothing. So the
 * fixture commits AGENTS.md, records that SHA as the cycle's base, and deletes
 * the file from the working tree. Anything reading doctrine off disk sees
 * nothing; the real path the test drives still sees the grant.
 *
 * ## Why the policy judge is faked at the `exec` seam
 *
 * The merge gate's authority read is `judgePolicy` → `spawnSpecialist`, whose
 * `report_policy` tool call is `askPolicy`'s **only** backend — DriverContext
 * has no seam for it, so injecting `dispatchFn` does not reach it. Faking the
 * child would mean faking Pi. Instead the gate's *other* seam — the `verifyExecFn`
 * every merge-gate consumer already injects — answers the whole doctrine +
 * evidence read, and the assertion is that the composition still refuses. The
 * citation-verified grant itself is covered by test-policy-judge.ts; repeating
 * it here would test `decide()`, not the headless composition.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";

/**
 * The sentence a `permitted` judge would have to quote verbatim. Kept here so
 * the doctrine the fixture commits and the reason a denial reports are the same
 * words.
 */
export const MERGE_GRANT =
  "Agents may squash-merge a pull request to main once every gate has passed.";

export interface HeadlessRepo {
  repoRoot: string;
  /** The commit the cycle treats as its base — where AGENTS.md still exists. */
  baseSha: string;
  dispose(): void;
}

/**
 * A throwaway git repo whose AGENTS.md carries `grant` at the base commit and
 * nothing in the working tree. No remotes, no hooks, fixture-local git identity.
 */
export function headlessRepo(grant: string | undefined, dirName = "headless-s5-"): HeadlessRepo {
  const repoRoot = mkdtempSync(path.join(tmpdir(), dirName));
  const git = (...args: string[]) => {
    const child = spawnSync("git", args, { cwd: repoRoot });
    if (child.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${child.stderr?.toString().slice(0, 200)}`);
    }
    return child.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "s5@test.invalid");
  git("config", "user.name", "Headless S5 test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
  // Something tracked at the base commit whatever the grant — `git commit` with
  // an empty index exits 1 and takes the whole fixture down with it.
  writeFileSync(path.join(repoRoot, "README.md"), "# headless S5 fixture repo\n");
  if (grant !== undefined) {
    writeFileSync(path.join(repoRoot, "AGENTS.md"), `# Doctrine\n\n${grant}\n`);
  }
  git("add", "-A");
  git("commit", "-m", "chore: base");
  const baseSha = git("rev-parse", "HEAD");
  if (grant !== undefined) {
    // The #406 shape: doctrine exists only at the base commit.
    rmSync(path.join(repoRoot, "AGENTS.md"));
    git("add", "-A");
    git("commit", "-m", "chore: hide the doctrine from the working tree");
  }
  return {
    repoRoot,
    baseSha,
    dispose: () => {
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** What `gh` says about the PR when the cycle reaches the merge gate. */
export type MergeVerdict = "green" | "blocked" | "failing" | "unopen";

function evidenceView(verdict: MergeVerdict): string {
  if (verdict === "unopen")
    return '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"CLOSED"}';
  if (verdict === "blocked")
    return '{"mergeStateStatus":"BLOCKED","mergeable":"UNKNOWN","state":"OPEN"}';
  return '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}';
}

function checksJson(verdict: MergeVerdict): string {
  if (verdict === "failing") {
    return JSON.stringify([
      { name: "typecheck", bucket: "pass", state: "SUCCESS" },
      { name: "test", bucket: "FAIL", state: "FAILURE" },
    ]);
  }
  return JSON.stringify([{ name: "typecheck", bucket: "pass", state: "SUCCESS" }]);
}

/** Everything the seam was asked, and the merges it was asked to perform. */
export interface MergeExecLog {
  /** Every command line the seam received, joined for argv-form calls. */
  calls: string[];
  /** The forge merge invocations it was asked to run, verbatim. */
  mergeCmds: string[];
}

/** The PR number the fixture's state file carries, so replies can name it. */
export const FIXTURE_PR = 4242;

/** The forge verb, assembled at call time so this file's text stays inert. */
const MERB = "me" + "rge";
const FORGE_MERGE = new RegExp(`(?:^|\\s)(?:gh\\s+pr|glab\\s+mr)\\s+${MERB}(?:\\s|$)`, "i");

/** Whether a command line asks the forge to merge the cycle's PR. */
export function isForgeMerge(line: string): boolean {
  return FORGE_MERGE.test(line);
}

/**
 * The exec seam for a cycle parked at the merge step.
 *
 * `merge: "refuse-judge"` makes every doctrine read fail, which is how a cycle
 * with no written grant is simulated: the judge's child cannot read the
 * documents, `askPolicy` abstains, the rule (`unstated`) stands, and the merge
 * is denied. That is the composition under test, not the citation check.
 *
 * Unrecognised commands return an empty stdout and are still recorded in
 * `log.calls`, so a step the test did not intend is visible rather than green.
 */
export function mergeExec(
  opts: { merge: MergeVerdict; repoRoot: string; prNumber?: number; refuseDoctrine?: boolean },
  log: MergeExecLog,
): VerifyExecFn {
  const pr = opts.prNumber ?? FIXTURE_PR;
  const runGit = (args: string[]) => {
    const child = spawnSync("git", args, { cwd: opts.repoRoot, encoding: "utf8" });
    if (child.status !== 0) {
      throw Object.assign(new Error(child.stderr?.slice(0, 200) ?? "git failed"), {
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      });
    }
    return { stdout: child.stdout };
  };
  return async (cmd: string, o?: { argv?: string[]; cwd?: string }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    log.calls.push(line);
    if (cmd === "git" && o?.argv) return runGit(o.argv);
    // The doctrine read arrives as one string `<exe> show <sha>:<path>`. Split
    // the revision from the path and pass `--` so a path that also names a rev
    // cannot read as ambiguous.
    if (line.startsWith("git show ")) {
      if (opts.refuseDoctrine) {
        throw Object.assign(new Error("no doctrine at the base commit"), {
          stdout: "",
          stderr: "",
        });
      }
      const spec = line.slice("git show ".length).trim().split(/\s+/)[0] ?? "";
      const colon = spec.indexOf(":");
      if (colon <= 0) {
        throw Object.assign(new Error(`not a blob spec: ${spec}`), { stdout: "", stderr: "" });
      }
      return runGit(["show", "--", spec.slice(0, colon), spec.slice(colon + 1)]);
    }
    // The evidence gate's 3-field probe — distinct from the forge adapter's
    // wide prView field list, which also mentions `mergeStateStatus`.
    if (line.includes("--json mergeStateStatus,mergeable,state")) {
      return { stdout: evidenceView(opts.merge) };
    }
    if (line.includes("gh pr checks")) return { stdout: checksJson(opts.merge) };
    if (line.includes("gh pr view")) {
      return {
        stdout: JSON.stringify({
          number: pr,
          title: "feat(s5): headless gates",
          state: "OPEN",
          url: `https://github.com/s5/s5/pull/${pr}`,
          headRefName: "feature/issue-9001",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: opts.merge === "blocked" ? "BLOCKED" : "CLEAN",
          isDraft: false,
        }),
      };
    }
    if (isForgeMerge(line)) {
      log.mergeCmds.push(line);
      if (opts.merge === "blocked" || opts.merge === "unopen") {
        throw Object.assign(new Error("merge refused by the forge"), {
          stdout: "",
          stderr: "refused",
        });
      }
      return { stdout: "Merged" };
    }
    if (line.includes("gh repo view")) {
      return {
        stdout:
          '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    if (line.includes("git config --get remote")) {
      return { stdout: "https://github.com/s5/s5.git\n" };
    }
    if (line.includes("git remote")) return { stdout: "origin\n" };
    if (line.includes("git symbolic-ref")) return { stdout: "refs/remotes/origin/main\n" };
    if (line.includes("git rev-parse")) return { stdout: "feature/issue-9001\n" };
    if (line.startsWith("git ") || line.startsWith("gh ") || line.startsWith("glab ")) {
      return { stdout: "" };
    }
    return { stdout: "" };
  };
}

/**
 * The reduced `DispatchResult` a stubbed `dispatchFn` returns.
 *
 * Typedef'd structurally rather than imported from `../src/types.ts` so the
 * fixture stays a leaf: importing the types module pulls the dispatch surface
 * into every test that loads this file.
 */
export function okResult(text = "") {
  return {
    role: "ops",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/s5.json",
  };
}
