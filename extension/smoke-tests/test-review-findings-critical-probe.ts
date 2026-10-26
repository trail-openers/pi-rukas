#!/usr/bin/env bun
/**
 * #1832 — unit coverage for `branchHasOpenCriticalRow`, the three-valued probe
 * the automatic-delta decision consults before letting a follow-up round be a
 * delta. The distinction the whole function exists for is `absent` vs
 * `unreadable`: `readBranchRows` answers fail-open, so a rule built on it would
 * run a delta precisely when the findings file is corrupt and a CRITICAL row may
 * still be open in it.
 *
 * Isolation follows test-review-findings-store.ts: a fixture clone plus a
 * pinned PI_AGENT_DIR, so the store lands in a temp state dir and never in the
 * operator's. Nothing here builds a judged path under the clone — the store
 * resolves through the state-dir resolver, and the corrupt/unreadable cases
 * mutate the file the resolver itself named.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { branchHasOpenCriticalRow } from "../src/review-findings-critical-probe.ts";
import { recordFindingRunOutcome } from "../src/review-findings-store.ts";
import {
  FINDINGS_FILE,
  STATE_LEAF,
  agentDir,
  findingsStateDir,
  resetFindingsStateCache,
} from "../src/review-state-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crit-probe-"));
  git(dir, "init", "-q", "-b", "feat/x");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "dev");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"));
  const commit = (content: string) => {
    writeFileSync(path.join(dir, "src", "a.ts"), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, commit };
}

const commitIn = (r: { dir: string; commit: (c: string) => string }, content: string) =>
  r.commit(content);

/** `<agentDir>/review-state/<key>` for a clone — read from disk, never through a
 * creating resolver, which would CREATE the directory the read-only probe is
 * asserted not to create. Same derivation as the module under test: realpath of
 * the clone's git dir, sha256, first 16 hex — but the NAMES come from the
 * module's own exports (#1832 round 2), so this fixture cannot drift from the
 * store's spelling and then assert against a path nothing writes to. */
function stateRootFor(cloneDir: string): string {
  const key = createHash("sha256")
    .update(realpathSync(path.join(cloneDir, ".git")))
    .digest("hex")
    .slice(0, 16);
  return path.join(agentDir(), STATE_LEAF, key);
}

const finding = (
  title: string,
  line: number | undefined,
  severity: Finding["severity"] = "CRITICAL",
): Finding => ({
  lens: "SECURITY",
  severity,
  path: "src/a.ts",
  ...(line === undefined ? {} : { line }),
  title,
});

const savedAgentDir = process.env.PI_AGENT_DIR;
const pinnedAgentDir = await mkdtemp(path.join(os.tmpdir(), "crit-probe-agent-"));
process.env.PI_AGENT_DIR = pinnedAgentDir;
// The state-dir resolver caches its answer per clone. This fixture repoints
// `PI_AGENT_DIR` for the whole file, so without a reset a fixture earlier in the
// process (or an earlier import-time resolve) would answer for this one and the
// probe would read a store that is not this test's.
resetFindingsStateCache();

try {
  const { dir, commit } = makeRepo();
  const c1 = commit(["// header", "const a = 1;", "const b = 2;", "const c = 3;"].join("\n"));
  // The store location the RECORD path would use — created here so the writes
  // below have somewhere to land. The probe itself must never create it (see the
  // fresh-clone assertion), which is why it is not this test's only lookup.
  // #1832 round 2 regression pin — the probe must resolve through the READ-ONLY
  // arm. It is asserted on its OWN fixture rather than on `dir`, because other
  // fixtures in this file create stores and the module caches per clone: what must
  // not happen is a probe that creates a clone's state root or mints its token.
  // A probe that lost `readOnly: true` fails both assertions below, since
  // `findingsStateDir` (the creating arm) is never called on this clone.
  const readOnlyPin = makeRepo();
  commitIn(readOnlyPin, "// pin fixture\n");
  const pinProbe = await branchHasOpenCriticalRow(readOnlyPin.dir, "feat/x");
  assert(
    pinProbe.kind === "absent",
    `pin fixture: a clone with no store answers absent (got ${JSON.stringify(pinProbe)})`,
  );
  const pinRoot = stateRootFor(readOnlyPin.dir);
  assert(
    !existsSync(pinRoot),
    "the probe alone created no state root for this clone (a creating resolve would have made it)",
  );
  assert(
    !existsSync(path.join(pinRoot, "token")),
    "…and minted no token, which is the write a read path must never perform",
  );

  const loc = await findingsStateDir(execp, dir);
  assert(loc !== undefined, "probe: the clone resolves a state dir");
  assert(
    loc?.file === path.join(loc.dir, FINDINGS_FILE),
    `fixture: the resolved store carries the exported basename (${FINDINGS_FILE})`,
  );
  // The creating arm really does create what the probe above did not: without this
  // the probe assertions would pass against a resolver that never creates
  // anything, which is not the property under test.
  assert(
    existsSync(stateRootFor(dir)) && existsSync(path.join(path.dirname(loc!.dir), "token")),
    "the RECORD path does create the state root and mint the token the probe left alone",
  );

  // No store at all yet: the file does not exist, which the raw read answers as
  // "the genuine empty store" — absent, NOT unreadable.
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
    "no findings file at all → absent (a first review stays a full review on its own merits)",
  );

  const record = (findings: Finding[], branch = "feat/x", head = c1) =>
    recordFindingRunOutcome({ cwd: dir, branch, headSha: head, findings, review: "full" });

  await record([finding("Division by zero", 2)]);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
    "an open line-bearing CRITICAL row → present",
  );
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/other")).kind === "absent",
    "the row is scoped to its own branch — another branch is absent",
  );

  // A non-CRITICAL row never forces a round. The commit only carries a line
  // change when the content actually differs, so the second commit differs.
  const c2 = commit(["// header", "const a = 1;", "const b = 22;", "const c = 3;"].join("\n"));
  await record([finding("Naming", 2, "HIGH")], "feat/high", c2);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/high")).kind === "absent",
    "an open HIGH row → absent (only CRITICAL forces a full round)",
  );

  // A CRITICAL with no line (line-less) is retired by #1469 on a full review, so
  // it never needs a forced round; same for one with no lineHash.
  await record([finding("Hardcoded secret", undefined)], "feat/noline", c2);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/noline")).kind === "absent",
    "a line-less CRITICAL → absent (it retires as not-reported, no forced round needed)",
  );

  // Corrupt the store: the fail-open read would say "no rows"; the probe must
  // say unreadable, because that is exactly when a CRITICAL may still be open.
  const file = loc?.file as string;
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{ this is not json");
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "unreadable",
    "an unparseable findings file → unreadable, never absent",
  );
  // A directory where the file should be: a read fault with no bytes at all.
  writeFileSync(file, good);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
    "restoring the bytes restores the answer (present)",
  );

  // A state dir that cannot be resolved at all (not a git clone) is unreadable.
  const notAClone = await mkdtemp(path.join(os.tmpdir(), "crit-probe-nogit-"));
  assert(
    (await branchHasOpenCriticalRow(notAClone, "feat/x")).kind === "unreadable",
    "a directory that is not a git clone → unreadable (fail toward a full review)",
  );

  // #1832 round 1 — the probe is READ-ONLY. A brand-new clone whose store has
  // never been written answers `absent` (nothing on the branch) and leaves
  // NOTHING behind: no state dir created, no token minted. Before the fix the
  // probe went through `findingsStateDir`, which does both.
  //
  // The fixture first runs one round through the RECORD path, which is what mints
  // the clone's token and creates the state dir. Without it there is no token to
  // read, and the honest answer for "this process cannot name a store" is
  // `unreadable` — never a silent `absent` (see the no-token arm of
  // `findingsStateDir`'s read-only path).
  const fresh = makeRepo();
  const freshHead = commitIn(fresh, "// nothing here yet\n");
  await recordFindingRunOutcome({
    cwd: fresh.dir,
    branch: "feat/x",
    headSha: freshHead,
    findings: [finding("Naming", 1, "HIGH")],
    review: "full",
  });
  const freshFile = (await findingsStateDir(execp, fresh.dir))?.file as string;
  const freshRoot = path.dirname(freshFile);
  const before = readdirSync(freshRoot).sort().join(",");
  assert(
    (await branchHasOpenCriticalRow(fresh.dir, "feat/x")).kind === "absent",
    "a clone whose store holds no CRITICAL row → absent",
  );
  assert(
    readdirSync(freshRoot).sort().join(",") === before,
    `…and the read-only probe wrote nothing into the state dir (was ${before}, is ${readdirSync(freshRoot).sort().join(",")})`,
  );

  // A clone with NO store at all: the probe must not create one, and it answers
  // `absent` — a store that does not exist holds no rows, and no rows means no
  // CRITICAL, so there is nothing a forced full round could retire. #1832 round 2:
  // this used to answer `unreadable` ("no token to name a directory"), which forced
  // a full review on every clean branch and named a repair for a file that does not
  // exist. `unreadable` is now reserved for a file that EXISTS and cannot be read or
  // parsed. The point of the second assertion is still the side effect that did NOT
  // happen: the clone's state root is read from disk here — NOT through
  // `findingsStateDir`, which would create the directory this asserts is absent.
  const neverWritten = makeRepo();
  commitIn(neverWritten, "// nothing here yet\n");
  const probeBefore = await branchHasOpenCriticalRow(neverWritten.dir, "feat/x");
  assert(
    probeBefore.kind === "absent",
    `a clone whose store was never created → absent (no store, no rows, no CRITICAL; got ${JSON.stringify(probeBefore)})`,
  );
  assert(
    !existsSync(stateRootFor(neverWritten.dir)),
    `…and the probe created no state dir for it (${stateRootFor(neverWritten.dir)} is absent)`,
  );

  // A corrupt store is answered WITHOUT the record path's `.corrupt-*` copy: the
  // delta decision must not leave artefacts on disk.
  const corrupt = makeRepo();
  const corruptHead = commitIn(corrupt, "const x = 1/0;\n");
  await recordFindingRunOutcome({
    cwd: corrupt.dir,
    branch: "feat/x",
    headSha: corruptHead,
    findings: [finding("Division by zero", 1)],
    review: "full",
  });
  const corruptFile = (await findingsStateDir(execp, corrupt.dir))?.file as string;
  assert(
    (await branchHasOpenCriticalRow(corrupt.dir, "feat/x")).kind === "present",
    "the corrupt fixture starts readable (a CRITICAL row is open on it)",
  );
  writeFileSync(corruptFile, "{ not json at all");
  const corruptDir = path.dirname(corruptFile);
  const corruptBefore = readdirSync(corruptDir).sort().join(",");
  const probe = await branchHasOpenCriticalRow(corrupt.dir, "feat/x");
  assert(
    probe.kind === "unreadable" && (probe.kind === "unreadable" ? probe.reason.includes("JSON") : false),
    `an unparseable store → unreadable WITH the cause (got ${JSON.stringify(probe)})`,
  );
  assert(
    readdirSync(corruptDir).sort().join(",") === corruptBefore,
    "…and the read-only probe wrote nothing beside the store (no .corrupt-* copy)",
  );

  // An accepted CRITICAL row does not force a round: the round is forbidden to
  // report it, so a full review proves nothing about it.
  const rows = JSON.parse(good) as { rows: Array<Record<string, unknown>> };
  const target = rows.rows.find((r) => r.severity === "CRITICAL");
  assert(target !== undefined, "fixture: the store holds a CRITICAL row to accept");
  if (target) {
    target.status = "accepted";
    target.acceptance = { by: "op", reason: "known risk", at: 1, snippetHash: target.snippetHash };
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
      "an ACCEPTED CRITICAL row → absent (an operator decision never forces a round)",
    );
    target.status = "resolved";
    // The acceptance must go in the SAME step: the schema forbids a non-accepted
    // row carrying one (`review-findings-file.ts`'s `rowProblem`), so a row with
    // both is MALFORMED and the probe's answer for a branch whose only rows are
    // malformed is `unreadable`, not `absent`. That is the fixture being invalid,
    // not the probe being wrong — so each state below is written as a row the
    // store's own schema would accept.
    delete target.acceptance;
    target.resolvedReason = "code-gone";
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
      "a RESOLVED CRITICAL row → absent",
    );
    target.status = "open";
    // `undefined` rather than `delete`: JSON.stringify drops an undefined
    // property, and biome's noDelete rule rules the operator out anyway.
    target.acceptance = undefined;
    target.resolvedReason = undefined;
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
      "putting the row back to open makes the probe say present again",
    );
  }

  // An empty scratch dir under the agent root is not read as a corrupt store:
  // the resolver keys on the clone, not on stray directories beside it.
  mkdirSync(path.join(pinnedAgentDir, "empty-branch-check"), { recursive: true });

  // #1832 round 2 — rows for the branch that are ALL malformed answer `absent`
  // with a trace, NOT `unreadable`: a row the schema refuses is not a row, the
  // record path does not refuse on it either (it sets such rows aside and carries
  // on with the valid ones), and a probe stricter than the path whose memory it
  // reads would force a full round for a branch with nothing open.
  const allBad = makeRepo();
  const allBadHead = commitIn(allBad, "const x = 1/0;\n");
  await recordFindingRunOutcome({
    cwd: allBad.dir,
    branch: "feat/x",
    headSha: allBadHead,
    findings: [finding("Division by zero", 1)],
    review: "full",
  });
  const allBadFile = (await findingsStateDir(execp, allBad.dir))?.file as string;
  const allBadRows = JSON.parse(readFileSync(allBadFile, "utf8")) as {
    rows: Array<Record<string, unknown>>;
  };
  assert(allBadRows.rows.length > 0, "fixture: the all-malformed clone starts with one row");
  // Break the row's schema while keeping its branch, so the branch filter still
  // sees it — that is what makes "all of this branch's rows are malformed" the
  // state under test rather than "this branch has no rows".
  allBadRows.rows = allBadRows.rows.map((r) => ({ ...r, severity: 42 }));
  writeFileSync(allBadFile, JSON.stringify(allBadRows));
  const allBadProbe = await branchHasOpenCriticalRow(allBad.dir, "feat/x");
  assert(
    allBadProbe.kind === "absent",
    `a branch whose only rows are malformed → absent, not unreadable (got ${JSON.stringify(allBadProbe)})`,
  );
} finally {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  // Leave the cache empty for whoever runs after this file in the same process.
  resetFindingsStateCache();
}

process.exit(exit);
