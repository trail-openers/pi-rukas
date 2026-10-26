#!/usr/bin/env bun
/**
 * #1832 round 2 — ONE location computation for the findings store.
 *
 * The open-CRITICAL probe (`review-findings-critical-probe.ts`) and the round's
 * own record path (`review-findings-store.ts`) used to arrive at the store's
 * path by two different routes: one read-only, one creating. Each had its own
 * copy of the override precedence, the common-dir lookup, the repo-key hash, the
 * token read and the corrupt-token fallback, and copies drift — which shows up
 * as the probe vetoing a delta on a store the round cannot see, or the reverse.
 *
 * Both arms now call the same `computeLocation` inside `review-state-path.ts`.
 * These assertions are the pin for that claim: for every shape of clone, the
 * read-only answer and the creating answer name the SAME file — including the
 * corrupt-token case, where both must name the same beside-the-ledger file
 * rather than one naming it and the other inventing a private token directory.
 *
 * And the read-only answer never creates: the state root of a clone whose store
 * was never made is still absent after a read-only lookup, and no token is
 * minted beside it. The creating arm is the opposite shape, and fixture 6 pins
 * it: once a clone's store exists in this process, a later resolve answers from
 * the cache — a deleted token file does not re-mint a directory or move the store
 * (#1832 round 3, a regression against `origin/main`). The second resolve must
 * leave the token file ABSENT: re-minting it is the symptom of a cache that is
 * never consulted.
 *
 * Every fixture uses a temp `PI_AGENT_DIR` and temp git repos; nothing here
 * touches the operator's `~/.pi/agent`.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { FINDINGS_FILE, STATE_LEAF, agentDir, findingsStateDir, findingsStoreLocation, resetFindingsStateCache } =
  await import("../src/review-state-path.ts");

const savedAgentDir = process.env.PI_AGENT_DIR;
const savedLedgerOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;

function tempAgentDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-agent-`));
  process.env.PI_AGENT_DIR = dir;
  resetFindingsStateCache();
  return dir;
}

function makeRepo(prefix: string): { repo: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const env = gitTestEnv();
  const git = (...args: string[]): string => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { repo, git };
}

/** The state root for a clone, derived the way the module does (realpath of the
 * common dir, sha256, first 16 hex) — read from disk, NEVER through a resolver
 * that would create it. */
function stateRootOf(agent: string, commonDir: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const { realpathSync } = require("node:fs") as typeof import("node:fs");
  const real = (() => {
    try {
      return realpathSync(commonDir);
    } catch {
      return path.resolve(commonDir);
    }
  })();
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(agent, STATE_LEAF, key);
}

try {
  // ── 1. a plain clone: the read-only and creating answers name ONE file ─────
  {
    const agent = tempAgentDir("loc-plain");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo } = makeRepo("loc-plain");
    // Read FIRST: a fresh clone has no token, so the read-only arm must answer a
    // location (not undefined) and report the store as not there yet.
    const before = await findingsStoreLocation(execp, repo);
    assert(before !== undefined, "a fresh clone still resolves a store location (read-only)");
    assert(before?.exists === false, "…which holds no store yet (exists: false)");
    // The location a READ names for a clone with no token is the beside-the-ledger
    // fallback — there is no token to name a directory with, and a read may not
    // mint one. What the read must NOT do is create the state root or a token:
    // that is the side effect the probe is forbidden, and the creating resolve
    // below is what actually relocates the store.
    assert(
      !existsSync(stateRootOf(agent, path.dirname(before!.ledger))),
      "…and the read-only lookup created nothing: the clone's state root is still absent",
    );

    const created = await findingsStateDir(execp, repo);
    assert(created !== undefined && !created.fellBack, "the creating resolve relocates the store");
    const after = await findingsStoreLocation(execp, repo);
    assert(
      after?.file === created!.file && after?.dir === created!.dir,
      "the read-only and creating answers name the SAME file for a plain clone",
    );
    assert(after?.exists === false, "a created store with no file yet reads as exists: false");
    writeFileSync(created!.file, '{"rows":[]}\n', "utf8");
    const withFile = await findingsStoreLocation(execp, repo);
    assert(withFile?.exists === true, "…and exists: true once the store's file is written");
    assert(
      withFile?.file === created!.file,
      "…named at the same file the creating path wrote (the read tracks the write)",
    );
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 2. the ledger-file override: both arms name the file beside the override ─
  {
    const agent = tempAgentDir("loc-override");
    const { repo } = makeRepo("loc-override");
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "loc-override-ledger-"));
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
    // The READ first, so this fixture also proves the override arm creates nothing.
    const readFirst = await findingsStoreLocation(execp, repo);
    const created = await findingsStateDir(execp, repo);
    const read = await findingsStoreLocation(execp, repo);
    assert(
      readFirst?.file === created?.file &&
        read?.file === created?.file &&
        read?.file === path.join(ledgerDir, FINDINGS_FILE),
      "an override: the read-only and creating answers both name the file beside the override",
    );
    assert(read?.exists === false, "…and say the store is not there yet");
    assert(
      !existsSync(path.join(agent, STATE_LEAF)),
      "…and neither arm touched the agent dir",
    );
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 3. a linked worktree: one store, named identically from both trees ──────
  {
    const agent = tempAgentDir("loc-worktree");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("loc-worktree");
    const wt = path.join(path.dirname(repo), "loc-wt");
    git("worktree", "add", "-q", "-b", "feat/wt", wt, "HEAD");
    const fromMain = await findingsStateDir(execp, repo);
    const fromWtRead = await findingsStoreLocation(execp, wt);
    const fromMainRead = await findingsStoreLocation(execp, repo);
    assert(
      fromWtRead?.file === fromMain?.file && fromMainRead?.file === fromMain?.file,
      "a linked worktree, the main checkout and the read-only arm all name ONE store",
    );
    assert(fromWtRead?.exists === false, "…and the worktree's read sees no file yet");
    git("worktree", "remove", "--force", wt);
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 4. a corrupt token: BOTH arms name the beside-ledger fallback ───────────
  {
    const agent = tempAgentDir("loc-badtok");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("loc-badtok");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const created = await findingsStateDir(execp, repo);
    const tokenFile = path.join(path.dirname(created!.dir), "token");
    for (const bad of ["", "deadbeefcafe0000", "0".repeat(31), "DEADBEEF".repeat(4)]) {
      writeFileSync(tokenFile, bad, "utf8");
      resetFindingsStateCache();
      const read = await findingsStoreLocation(execp, repo);
      resetFindingsStateCache();
      const again = await findingsStateDir(execp, repo);
      assert(
        read?.fellBack === true && again?.fellBack === true,
        `a malformed token (${bad.length} chars) falls back beside the ledger in BOTH arms`,
      );
      assert(
        read?.file === again?.file && read?.file === path.join(commonDir, FINDINGS_FILE),
        `…and both name the SAME beside-the-ledger file for a ${bad.length}-char token`,
      );
      assert(
        read?.exists === existsSync(path.join(commonDir, FINDINGS_FILE)),
        "…and exists describes that same fallback file",
      );
    }
    // An unreadable token file (a directory in its place) is the same answer.
    rmSync(tokenFile);
    mkdirSync(tokenFile);
    resetFindingsStateCache();
    const readDir = await findingsStoreLocation(execp, repo);
    resetFindingsStateCache();
    const createDir = await findingsStateDir(execp, repo);
    assert(
      readDir?.file === createDir?.file && readDir?.fellBack === true,
      "an unreadable token file: both arms name the beside-ledger fallback",
    );
    assert(
      !existsSync(path.join(path.dirname(stateRootOf(agent, commonDir)), "DEADBEEFDEADBEEFDEADBEEFDEADBEEF")),
      "…and no private minted token directory was created by the read",
    );
    rmSync(tokenFile, { recursive: true, force: true });
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 5. the read-only arm is side-effect-free even when the store is missing ─
  {
    const agent = tempAgentDir("loc-noside");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("loc-noside");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const read = await findingsStoreLocation(execp, repo);
    assert(read !== undefined && read.exists === false, "the read answered a location");
    assert(
      !existsSync(stateRootOf(agent, commonDir)),
      `the read-only lookup created no state root (${STATE_LEAF} under agentDir is untouched)`,
    );
    assert(!existsSync(path.join(agent, STATE_LEAF)), "…the leaf directory itself does not exist");
    assert(agentDir() === process.env.PI_AGENT_DIR, "agentDir() is the pinned temp root");
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
  // ── 6. the creating path READS its cache: a deleted token does not mint a
  //       second directory (#1832 round 3, the regression against origin/main) ──
  //
  // `computeLocation` answers the location from disk every time — that is what
  // makes the read-only locator tell "no store yet" from "a file that will not
  // parse". The CREATING arm sits in front of it with a process cache, exactly
  // where origin/main had it: once this process has created a clone's store, a
  // later resolve for the same clone answers from memory. Without that read every
  // resolve re-reads the token file and asks `tokenFor` to mint, so deleting the
  // token after the first round makes the next one name a brand-new directory and
  // the clone silently loses its memory.
  {
    const agent = tempAgentDir("loc-cache");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("loc-cache");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));

    const first = await findingsStateDir(execp, repo);
    assert(first !== undefined && !first.fellBack, "cache: the first resolve creates the store");
    if (!first) throw new Error("the cache fixture resolved no store");
    const tokenFile = path.join(path.dirname(first.dir), "token");
    assert(existsSync(tokenFile), "cache: the token is on disk after the creating resolve");
    // Snapshot the root BEFORE deleting anything: what a cache miss does is write
    // a token file back, so the assertion has to compare against the shape that
    // held no token at all.
    const tokenGone = () => !existsSync(tokenFile);
    rmSync(tokenFile);
    const second = await findingsStateDir(execp, repo);
    assert(second !== undefined, "cache: the second resolve still answers");
    assert(
      second!.dir === first.dir && second!.file === first.file,
      "cache: the same key answers the SAME location after the token file is gone",
    );
    assert(!second!.fellBack, "…not the beside-the-ledger fallback");
    assert(
      tokenGone(),
      "…and the cache answered WITHOUT a re-mint: the token file is still absent",
    );
    // One directory under this clone's state root, still the first one. The
    // re-mint this asserts against would have created a sibling 32-hex directory
    // that every later process names instead of the store holding the rows.
    const root = stateRootOf(agent, commonDir);
    const dirs = readdirSync(root)
      .filter((name) => name !== "token")
      .sort();
    assert(
      dirs.length === 1 && dirs[0] === path.basename(first.dir),
      `…and no second token directory exists for the clone (root holds ${dirs.join(", ")})`,
    );

    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
} finally {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  if (savedLedgerOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedgerOverride;
  resetFindingsStateCache();
}

process.exit(exit);
