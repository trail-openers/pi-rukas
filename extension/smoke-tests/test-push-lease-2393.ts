#!/usr/bin/env bun
/**
 * #2393 — a branch this run published is pushed again with a lease on the sha it
 * pushed, and a refused push says whether the branch moved or the content was refused.
 *
 *   1. integrate() pushes the branch, then a second integrate() rewrites it (the
 *      commit-pr re-run after a failure past the push). The second push carries
 *      `--force-with-lease=<branch>:<sha this run pushed>` and lands. Never a bare --force.
 *   2. Someone else moved the branch after that push: the lease fails (`stale info`),
 *      the push stays refused, and the cause says the branch moved, not push protection.
 *   3. The incident's own non-fast-forward text is classed as moved too.
 *   4. GH013 is still push protection, with the allow-the-content action.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { causeForCycle } from "../src/work-driver-cause-for.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { pushRefusalKind } from "../src/work-driver-push-refusal.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BRANCH = "feature/issue-138-x";
const BASE = "1".repeat(40);
const PICK = "3".repeat(40);
const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);
const OTHER = "9".repeat(40);

/** A remote that refuses what GitHub refuses: a non-fast-forward, or a lease on a stale sha. */
function forge() {
  const remote: { sha?: string; pushes: string[][] } = { pushes: [] };
  let head = FIRST;
  const refuse = (why: string) => {
    const err = new Error(`Command failed: git push -u origin ${BRANCH}`) as Error & {
      stderr?: string;
    };
    err.stderr = [
      "To https://github.com/o/r.git",
      ` ! [rejected]        ${BRANCH} -> ${BRANCH} (${why})`,
      "error: failed to push some refs to 'https://github.com/o/r.git'",
    ].join("\n");
    return err;
  };
  const exec = async (
    cmd: string,
    o?: { argv?: string[] },
  ): Promise<{ stdout: string; stderr?: string }> => {
    const argv = o?.argv ?? [];
    const line = argv.length > 0 ? `${cmd} ${argv.join(" ")}` : cmd;
    if (cmd === "git" && argv[0] === "push") {
      remote.pushes.push(argv);
      if (argv.some((a) => a === "--force" || a === "-f" || a.startsWith("+"))) {
        throw new Error("test: a bare force push was attempted");
      }
      const lease = argv.find((a) => a.startsWith("--force-with-lease="));
      if (lease !== undefined) {
        if (lease !== `--force-with-lease=${BRANCH}:${remote.sha}`) throw refuse("stale info");
      } else if (remote.sha !== undefined) {
        // Every rewrite in this test replaces the remote tip, so a plain push is refused.
        throw refuse("non-fast-forward");
      }
      remote.sha = head;
      return { stdout: "" };
    }
    if (line.startsWith("git rev-list --reverse --first-parent")) return { stdout: `${PICK}\n` };
    if (line.startsWith("git rev-list --count ")) return { stdout: "1\n" };
    if (line.startsWith("git diff --cached --name-only")) return { stdout: "README.md\n" };
    if (line === "git rev-parse HEAD") return { stdout: `${head}\n` };
    return { stdout: "" };
  };
  return { remote, exec, setHead: (s: string) => (head = s) };
}

function run(dir: string, exec: ReturnType<typeof forge>["exec"]) {
  return integrate(exec, {
    repoRoot: dir,
    branchName: BRANCH,
    baseSha: BASE,
    worktrees: { default: path.join(dir, ".worktrees/issue-138-default") },
    scratchDir: path.join(dir, "tmp/issue-138"),
    commitTitle: "chore(work): The README shows the tehas wordmark",
    commitBody: "Fixes #138",
    mode: "create",
    commitShas: { default: PICK },
  });
}

function parked(reason: string): WorkState {
  return {
    issue: 138,
    pipelineState: { currentStep: "commit-pr", reviewRound: 0, branchName: BRANCH },
    eventLog: [
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "push-refused:commit-pr",
        reviewRound: 0,
        nextStep: "handoff",
        evidence: reason,
        failures: [reason],
      },
    ],
  } as unknown as WorkState;
}

// 1 + 2. The run's own push, the lease push after it, and a branch someone else moved.
{
  const dir = mkdtempSync(path.join(tmpdir(), "push-lease-"));
  try {
    const f = forge();
    const first = await run(dir, f.exec);
    assert(first.ok === true && f.remote.sha === FIRST, "the first push publishes the branch");
    assert(
      !f.remote.pushes[0]?.some((a) => a.startsWith("--force-with-lease")),
      "a branch this run never pushed is pushed without a lease (a plain push)",
    );

    f.setHead(SECOND);
    const second = await run(dir, f.exec);
    assert(second.ok === true, "the rewrite of the branch this run published is pushed");
    assert(
      f.remote.pushes[1]?.includes(`--force-with-lease=${BRANCH}:${FIRST}`) === true,
      "#2393: the second push leases on the exact sha this run pushed",
    );
    assert(f.remote.sha === SECOND, "#2393: the remote now holds the rewritten branch");

    // Someone else pushes to the branch. The run's next rewrite must not overwrite it.
    f.remote.sha = OTHER;
    f.setHead(FIRST);
    const third = await run(dir, f.exec);
    assert(
      third.ok === false && third.failure === "push-refused",
      "#2393: a branch someone else moved stays refused (the lease protects it)",
    );
    assert(f.remote.sha === OTHER, "#2393: the other person's commit is still on the remote");
    assert(
      f.remote.pushes[2]?.includes(`--force-with-lease=${BRANCH}:${SECOND}`) === true,
      "#2393: the lease names the sha this run pushed last, not the remote's current tip",
    );
    const reason = third.ok ? "" : third.reason;
    assert(pushRefusalKind(reason) === "moved", "#2393: a failed lease is classed as moved");
    const verdict = causeForCycle(parked(reason));
    assert(
      /moved/i.test(verdict?.causeReason ?? "") &&
        !/push protection/i.test(verdict?.causeReason ?? ""),
      "#2393: the cause says the branch moved, not push protection",
    );
    assert(
      /remote branch/i.test(verdict?.userAction ?? "") &&
        !/allow the flagged content/i.test(verdict?.userAction ?? ""),
      "#2393: the action is to look at the remote branch, not to allow flagged content",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. The incident's refusal text, as recorded on tehas-lab#138.
{
  const incident = [
    `push refused by the remote for ${BRANCH}: To https://github.com/o/r.git`,
    ` ! [rejected]        ${BRANCH} -> ${BRANCH} (non-fast-forward)`,
    "error: failed to push some refs to 'https://github.com/o/r.git'",
    "hint: Updates were rejected because the tip of your current branch is behind",
    "hint: its remote counterpart. If you want to integrate the remote changes,",
  ].join("\n");
  assert(pushRefusalKind(incident) === "moved", "#2393: non-fast-forward is classed as moved");
  assert(
    pushRefusalKind(` ! [rejected]        ${BRANCH} -> ${BRANCH} (fetch first)`) === "moved",
    "#2393: fetch first is classed as moved",
  );
  const verdict = causeForCycle(parked(incident));
  assert(
    !/push protection|GH013|secret/i.test(`${verdict?.causeReason} ${verdict?.userAction}`),
    "#2393: the incident's handoff no longer points at push protection or secrets",
  );
}

// 4. GH013 is still push protection.
{
  const gh013 = [
    `remote: error: GH013: Repository rule violations found for refs/heads/${BRANCH}.`,
    "remote: - GITHUB PUSH PROTECTION",
    "remote:     * Push the commit again to allow the secret: https://github.com/o/r/security/secret_scanning/unblock-secret/3Kvj3Vlk",
    ` ! [remote rejected] ${BRANCH} -> ${BRANCH} (push declined due to repository rule violations)`,
  ].join("\n");
  assert(pushRefusalKind(gh013) === "protection", "#2393: GH013 is still push protection");
  assert(
    pushRefusalKind("fatal: could not read from remote repository") === undefined,
    "transport noise is neither",
  );
  const verdict = causeForCycle(parked(gh013));
  assert(
    /allow the flagged content/i.test(verdict?.userAction ?? ""),
    "#2393: GH013 keeps the allow-the-flagged-content action",
  );
}

process.exit(exit);
