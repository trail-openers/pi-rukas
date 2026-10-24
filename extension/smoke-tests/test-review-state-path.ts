#!/usr/bin/env bun
/**
 * #1764 phase 1 — the findings store lives OUTSIDE the repository.
 *
 * The accept guard used to have to recognise every shell shape that could name
 * `review-findings.json` under the git common dir, and it refused ~6,400
 * ordinary agent commands doing it. The fix is to move the data where an agent
 * is never told the name of: `<agentDir>/review-state/<key>/<token>/`. These
 * tests pin the properties that make that true and safe:
 *
 *   1. one key for a clone — the main checkout and a LINKED WORKTREE resolve the
 *      same directory (the property the old beside-the-ledger layout had);
 *   2. permissions are 0700 dirs and 0600 files, not umask's accident;
 *   3. migration — an existing file under the git common dir is copied in (rows
 *      preserved), the old one removed, `MIGRATED` written;
 *   4. idempotence — a second resolve moves nothing;
 *   5. both files present — the live store wins, the old bytes are set aside
 *      rather than overwritten;
 *   6. an unwritable root falls back to the old location and does not throw;
 *   7. `PI_ENSEMBLE_REVIEW_LEDGER_FILE` keeps the findings file beside the
 *      override (what the whole offline suite isolates on).
 *
 * Every fixture uses a temp `PI_AGENT_DIR` and temp git repos; nothing here
 * reads or writes the real `~/.pi/agent`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const { FINDINGS_FILE, STATE_LEAF, agentDir, findingsStateDir, resetFindingsStateCache } =
  await import("../src/review-state-path.ts");
const { reviewStateRoots } = await import("../src/review-accept-guard.ts");

const ROWS = { rows: [{ id: "deadbeef", branch: "feat/x", title: "a stored finding" }] };

const savedAgentDir = process.env.PI_AGENT_DIR;
const savedLedgerOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;

/** A temp agent dir, private to this process. */
function tempAgentDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-agent-`));
  process.env.PI_AGENT_DIR = dir;
  resetFindingsStateCache();
  return dir;
}

/** A real git clone in a temp dir, with one commit so the common dir exists. */
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

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

try {
  // ── 1 + 2: one key per clone, shared with every linked worktree, 0700/0600 ──
  {
    const agent = tempAgentDir("state-shared");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-shared");
    const wt = path.join(path.dirname(repo), "linked-wt");
    git("worktree", "add", "-q", "-b", "feat/wt", wt, "HEAD");

    const main = await findingsStateDir(execp, repo);
    const work = await findingsStateDir(execp, wt);
    assert(main !== undefined && work !== undefined, "both checkouts resolve a store");
    if (!main || !work) throw new Error("the fixture clone resolved no findings store");
    assert(main.dir === work.dir, "a linked worktree shares the main checkout's store dir");
    assert(main?.file === work?.file, "…and the same findings file");
    assert(!main.fellBack, "the store is relocated, not left beside the ledger");
    assert(
      main.dir.startsWith(path.join(agentDir(), STATE_LEAF)),
      "the store lives under <agentDir>/review-state, as the exported pair spells it",
    );
    assert(
      !main.file.startsWith(repo) && !main.dir.includes(`${path.sep}.git`),
      "the store is neither in the repository nor under the git dir",
    );
    assert(
      /^[0-9a-f]{16}$/.test(path.basename(path.dirname(main.dir))),
      "the per-clone key is 16 hex chars of the common dir's digest",
    );
    assert(
      /^[0-9a-f]{32}$/.test(path.basename(main.dir)),
      "the leaf is a 32-hex random token nobody can derive",
    );
    assert(
      modeOf(path.dirname(main.dir)) === 0o700 && modeOf(main.dir) === 0o700,
      `state dirs are 0700 (got ${modeOf(path.dirname(main.dir)).toString(8)} / ${modeOf(main.dir).toString(8)})`,
    );
    // A file written by the store lands 0600 — the resolver owns the directory,
    // so this asserts the dir it created is not world-readable and a token file
    // is not world-readable either.
    assert(modeOf(path.join(path.dirname(main.dir), "token")) === 0o600, "the token file is 0600");
    const tokenFile = path.join(path.dirname(main.dir), "token");
    assert(
      readFileSync(tokenFile, "utf8").trim() === path.basename(main.dir),
      "the token on disk is the directory name (a racing process re-reads it)",
    );
    git("worktree", "remove", "--force", wt);
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 3 + 4: migration from the old location, once ──────────────────────────
  {
    const agent = tempAgentDir("state-migrate");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-migrate");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const oldFile = path.join(commonDir, FINDINGS_FILE);
    writeFileSync(oldFile, JSON.stringify(ROWS, null, 2), "utf8");

    const loc = await findingsStateDir(execp, repo);
    assert(loc !== undefined && !loc.fellBack, "the relocated store was created");
    if (!loc) throw new Error("the migration fixture resolved no store");
    assert(!existsSync(oldFile), "the old file under the git common dir is gone");
    assert(existsSync(path.join(loc.dir, "MIGRATED")), "MIGRATED is written");
    assert(
      JSON.parse(readFileSync(loc.file, "utf8")).rows[0].title === "a stored finding",
      "the rows survived the move",
    );
    assert(modeOf(loc.file) === 0o600, `the migrated file is 0600 (got ${modeOf(loc.file).toString(8)})`);

    // Idempotence: put a file back and resolve again — the marker means the
    // second resolve does nothing at all.
    const before = readFileSync(loc.file, "utf8");
    writeFileSync(oldFile, '{"rows":[{"id":"cafe0000","title":"a second round"}]}\n', "utf8");
    const again = await findingsStateDir(execp, repo);
    if (!again) throw new Error("the second resolve returned nothing");
    assert(again.dir === loc.dir, "a second resolve returns the same directory");
    assert(existsSync(oldFile), "a second resolve does NOT migrate again (MIGRATED honoured)");
    assert(readFileSync(again.file, "utf8") === before, "…and does not touch the live store");

    git("worktree", "prune");
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 5: both files present — the live store wins, the old bytes are kept ────
  {
    const agent = tempAgentDir("state-both");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-both");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const oldFile = path.join(commonDir, FINDINGS_FILE);
    writeFileSync(oldFile, '{"rows":[{"id":"0dd1e5d1","title":"the old row"}]}\n', "utf8");
    const first = await findingsStateDir(execp, repo);
    if (!first) throw new Error("the both-present fixture resolved no store");
    // The first resolve migrated; simulate a round having written the live store
    // and an old file reappearing (a restore from a stale worktree, a checkout).
    writeFileSync(first.file, JSON.stringify(ROWS, null, 2), "utf8");
    writeFileSync(oldFile, '{"rows":[{"id":"0dd1e5d1","title":"the old row"}]}\n', "utf8");
    rmSync(path.join(first.dir, "MIGRATED"));
    resetFindingsStateCache();
    const second = await findingsStateDir(execp, repo);
    if (!second) throw new Error("the second resolve returned nothing");
    assert(
      JSON.parse(readFileSync(second.file, "utf8")).rows[0].title === "a stored finding",
      "the live store's rows are kept when both files exist",
    );
    assert(!existsSync(oldFile), "the old file is still removed from the git dir");
    const aside = `${second.file}.pre-migration`;
    assert(existsSync(aside), "the old bytes are set aside beside the live store");
    assert(
      JSON.parse(readFileSync(aside, "utf8")).rows[0].title === "the old row",
      "…and are readable there",
    );
    assert(modeOf(aside) === 0o600, "the set-aside copy is 0600");
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 6: an unwritable root falls back without throwing ──────────────────────
  {
    const agent = tempAgentDir("state-readonly");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-readonly");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    // Make the agent dir refuse children: a fresh `review-state` cannot be made.
    chmodSync(agent, 0o500);
    let loc: Awaited<ReturnType<typeof findingsStateDir>>;
    let threw = false;
    try {
      loc = await findingsStateDir(execp, repo);
    } catch {
      threw = true;
    }
    chmodSync(agent, 0o700);
    assert(!threw, "an unwritable state root does not throw");
    assert(loc !== undefined, "…and still answers with a location");
    if (!loc) throw new Error("the fallback probe returned nothing");
    assert(loc.fellBack, "…flagged as the fallback");
    assert(
      path.dirname(loc.file) === commonDir,
      "the fallback is the old location, beside the ledger",
    );
    assert(loc.file === path.join(commonDir, FINDINGS_FILE), "…with the store's basename");
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 7: the override keeps the findings file beside the override ────────────
  {
    const agent = tempAgentDir("state-override");
    const { repo, git } = makeRepo("state-override");
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "state-override-ledger-"));
    const ledgerFile = path.join(ledgerDir, "review-ledger.json");
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
    const loc = await findingsStateDir(execp, repo);
    assert(loc?.ledger.endsWith("review-ledger.json") === true, "the ledger still resolves");
    assert(loc?.dir === ledgerDir, "an override keeps the store in the override's directory");
    assert(
      loc?.file === path.join(ledgerDir, FINDINGS_FILE),
      "the findings file sits beside the overridden ledger",
    );
    assert(!existsSync(path.join(agent, "review-state")), "…and nothing was created in the agent dir");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 8: interrupted migrations converge, with no rows lost ─────────────────
  //
  // The marker is written LAST and the old file unlinked BEFORE it, so each
  // crash point leaves a state the next resolve recognises and finishes. Each
  // fixture below is the exact on-disk shape a kill leaves behind.
  {
    const agent = tempAgentDir("state-crash");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-crash");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const oldFile = path.join(commonDir, FINDINGS_FILE);
    const OLD = '{"rows":[{"id":"cafe0000","title":"the crashed row"}]}\n';

    // (a) copy landed, process died before the marker: rows already live.
    const a = await findingsStateDir(execp, repo);
    writeFileSync(a!.file, OLD, "utf8");
    rmSync(path.join(a!.dir, "MIGRATED"));
    resetFindingsStateCache();
    const a2 = await findingsStateDir(execp, repo);
    const b_dir = a2!.dir;
    assert(
      existsSync(path.join(a2!.dir, "MIGRATED")),
      "crash A (copy landed, no marker): the marker is written on the next resolve",
    );
    assert(
      readFileSync(a2!.file, "utf8") === OLD,
      "crash A: the live rows are untouched by finishing the migration",
    );

    // (b) old and live hold the SAME bytes: the copy landed, the unlink did not.
    // The file is absent here, so this resolve takes the plain copy path and
    // leaves exactly the crashed shape: old and live byte-identical, no marker.
    rmSync(a!.file);
    writeFileSync(oldFile, OLD, "utf8");
    resetFindingsStateCache();
    await findingsStateDir(execp, repo);
    assert(existsSync(oldFile), "crash B: the fixture holds the old file beside an identical live file");
    rmSync(path.join(b_dir!, "MIGRATED"));
    resetFindingsStateCache();
    const b = await findingsStateDir(execp, repo);
    assert(readFileSync(b!.file, "utf8") === OLD, "crash B (identical bytes): the live file holds the rows");
    assert(!existsSync(oldFile), "crash B: the old file is unlinked");
    assert(existsSync(path.join(b!.dir, "MIGRATED")), "crash B: the marker follows the unlink");
    assert(
      !existsSync(`${b!.file}.pre-migration`),
      "crash B: identical bytes are NOT set aside — nothing was distinct to keep",
    );

    // (c) old absent, live absent, no marker: nothing to move, marker anyway.
    rmSync(b!.file);
    resetFindingsStateCache();
    const c = await findingsStateDir(execp, repo);
    assert(
      existsSync(path.join(c!.dir, "MIGRATED")),
      "crash C (nothing at either path): the marker is written and resolve succeeds",
    );

    // (d) old and live hold DIFFERENT bytes: the set-aside path still fires.
    writeFileSync(c!.file, JSON.stringify(ROWS, null, 2), "utf8");
    writeFileSync(oldFile, '{"rows":[{"id":"0dd1e5d1","title":"a divergent row"}]}\n', "utf8");
    rmSync(path.join(c!.dir, "MIGRATED"));
    resetFindingsStateCache();
    const d = await findingsStateDir(execp, repo);
    assert(
      JSON.parse(readFileSync(d!.file, "utf8")).rows[0].title === "a stored finding",
      "crash D (divergent bytes): the live rows win",
    );
    assert(
      JSON.parse(readFileSync(`${d!.file}.pre-migration`, "utf8")).rows[0].title ===
        "a divergent row",
      "crash D: the divergent old bytes are readable in the set-aside",
    );
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 9: an unreadable or malformed token falls back; never a private token ──
  {
    const agent = tempAgentDir("state-badtok");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-badtok");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const loc = await findingsStateDir(execp, repo);
    const root = path.dirname(loc!.dir);
    const tokenFile = path.join(root, "token");

    // A truncated write is a directory nobody can find again: 31 chars is not a
    // token, and neither is 16 (the old, too-permissive acceptance).
    for (const bad of ["deadbeefcafe0000", "0".repeat(31), "DEADBEEF".repeat(4), "not-a-token"]) {
      writeFileSync(tokenFile, bad, "utf8");
      resetFindingsStateCache();
      const fell = await findingsStateDir(execp, repo);
      assert(fell!.fellBack, `a malformed token (${bad.length} chars) falls back beside the ledger`);
      assert(
        reviewStateRoots().some((r) => r.startsWith(agentDir())),
        "the guard builds its resolved root from the same agentDir the store writes into",
      );
      assert(
        path.dirname(fell!.file) === commonDir,
        `…and the fallback is the ledger's own directory for a ${bad.length}-char token`,
      );
    }
    // A token file that cannot be read at all (a directory in its place).
    rmSync(tokenFile);
    mkdirSync(tokenFile);
    resetFindingsStateCache();
    const unreadable = await findingsStateDir(execp, repo);
    assert(unreadable!.fellBack, "an unreadable token file falls back beside the ledger");
    assert(
      !existsSync(path.join(root, "DEADBEEFDEADBEEFDEADBEEFDEADBEEF")),
      "no private minted token is ever used as a directory",
    );
    rmSync(tokenFile, { recursive: true, force: true });
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }

  // ── 10: a state dir that cannot be made 0700 is not a state dir ────────────
  //
  // `chmodSync` is masked by nothing, so a filesystem that will not carry the
  // mode is induced here by making the directory immutable: the chmod fails with
  // EPERM and the mode that reads back is 0755, not 0700. The resolver must then
  // keep the store beside the ledger rather than in a group/world-readable dir.
  {
    let agent = tempAgentDir("state-mode");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-mode");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    const root = mkdtempSync(path.join(os.tmpdir(), "state-mode-agent-"));
    const immutable = path.join(root, STATE_LEAF);
    mkdirSync(immutable, { mode: 0o755 });
    chmodSync(immutable, 0o755);
    const { execFileSync, spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const chattr = spawnSync("chattr", ["+i", immutable], { encoding: "utf8" });
    if (chattr.status !== 0) {
      console.log(`- skipped: chattr +i unavailable (${chattr.stderr.trim() || chattr.status})`);
    } else {
      try {
        process.env.PI_AGENT_DIR = root;
        resetFindingsStateCache();
        const stuck = await findingsStateDir(execp, repo);
        assert(stuck!.fellBack, "a state root that will not take 0700 falls back beside the ledger");
        assert(
          path.dirname(stuck!.file) === commonDir,
          "…and the fallback is the ledger's own directory, not a world-readable dir",
        );
      } finally {
        execFileSync("chattr", ["-i", immutable], { encoding: "utf8" });
        agent = root;
      }
    }
    chmodSync(immutable, 0o700);
    rmSync(path.dirname(repo), { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }

  // ── the store's own resolver agrees with these properties ──────────────────
  {
    const agent = tempAgentDir("state-store");
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    const { repo, git } = makeRepo("state-store");
    const commonDir = path.resolve(repo, git("rev-parse", "--git-common-dir"));
    writeFileSync(path.join(commonDir, FINDINGS_FILE), '{"rows":[]}\n', "utf8");
    const { readBranchRows } = await import("../src/review-findings-store.ts");
    const rows = await readBranchRows(repo, "feat/x");
    assert(Array.isArray(rows) && rows.length === 0, "the store reads an empty relocated store");
    assert(
      !existsSync(path.join(commonDir, FINDINGS_FILE)),
      "reading through the store migrated the old file out of the git dir",
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
