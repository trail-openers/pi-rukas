#!/usr/bin/env bun
/**
 * #1908 — `moveToTip`'s `byPatchEquivalence` parameter is dead.
 *
 * Both callers in `work-driver-lens-fix-reposition-gate.ts` pass the literal
 * `true`, and the parameter's own jsdoc says so ("Every current caller passes
 * true ... the fast-forward arm does not come through here"). Everything it
 * feeds is therefore a constant: `movedByPatchEquivalence` on the result is
 * always true, and the `: "fast-forward to the remote tip"` half of the trace
 * clause is unreachable text.
 *
 * **What is observable is the arity.** Today the parameter sits between `why`
 * and the end of the signature, so the 8-argument call the removal leaves puts
 * `undefined` in `tipSha` and the SHA guard refuses before the checkout — the
 * tree does not move. Remove the parameter and that same call is the correct
 * one: `tipSha` is the sha in position 7, the tree lands on it, and the result
 * carries no `movedByPatchEquivalence` key at all (that field only ever existed
 * to carry the parameter's constant value). Both halves are asserted against
 * the real entry point over a real scratch repo.
 *
 * Second assertion: no file under `extension/src` mentions the name any more.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RepositionResult } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { moveToTip } from "../src/work-driver-lens-fix-reposition-move.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
const TEST = "test-AC1-movetotip-no-bypatchequivalence.ts";

let exit = 0;
function fail(msg: string) {
  console.error(`FAIL ${TEST}: ${msg}`);
  exit = 1;
}

/** Real exec honouring the driver's argv form, as the sibling git tests do. */
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      timeout: o.timeout,
      env: o.env,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** The call the removal leaves: execFn + 8 positional arguments, `tipSha`
 *  last-but-one and `why` last, and nothing after them. */
const callMoveToTip = moveToTip as unknown as (...args: unknown[]) => Promise<RepositionResult>;

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1908-"));
  const tree = path.join(root, "repo");
  try {
    mkdirSync(tree, { recursive: true });
    await git(tree, ["init", "-q"]);
    await git(tree, ["config", "user.email", "t@example.invalid"]);
    await git(tree, ["config", "user.name", "t"]);
    await git(tree, ["config", "commit.gpgsign", "false"]);
    mkdirSync(path.join(tree, "src"), { recursive: true });
    writeFileSync(path.join(tree, "src", "a.ts"), "export const a = 1;\n");
    await git(tree, ["add", "-A"]);
    await git(tree, ["commit", "-q", "-m", "base"]);
    const sha = (await git(tree, ["rev-parse", "HEAD"])).stdout.trim();

    const res = await callMoveToTip(
      realExec,
      tree,
      "feature/issue-1908-example",
      [1908],
      "chore: remove the dead parameter",
      sha,
      sha,
      "one worktree commit already on the branch",
    );

    if (res.kind !== "repositioned") {
      fail(
        `the 8-argument call returned "${res.kind}" (detail: ${res.detail ?? "n/a"}): with byPatchEquivalence still in the signature the 8th argument never reaches tipSha`,
      );
    } else if (res.tipSha !== sha) {
      fail(
        `the 8-argument call landed on ${res.tipSha.slice(0, 12)}, expected ${sha.slice(0, 12)}`,
      );
    } else if ("movedByPatchEquivalence" in res) {
      fail(
        `result still carries the key derived from the dead parameter: movedByPatchEquivalence=${JSON.stringify(res.movedByPatchEquivalence)}`,
      );
    } else {
      console.log("✓ moveToTip moves the tree to the tip on an 8-argument call");
      console.log("✓ the result no longer carries movedByPatchEquivalence");
    }

    // No file under extension/src mentions the dead name any more.
    const extensionDir = path.join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith(".ts") &&
          readFileSync(full, "utf8").includes("byPatchEquivalence")
        ) {
          offenders.push(path.relative(extensionDir, full));
        }
      }
    };
    walk(path.join(extensionDir, "src"));
    if (offenders.length > 0) {
      fail(`byPatchEquivalence still referenced in ${offenders.join(", ")}`);
    } else {
      console.log("✓ no file under extension/src references byPatchEquivalence");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  process.exit(exit);
}

main();
