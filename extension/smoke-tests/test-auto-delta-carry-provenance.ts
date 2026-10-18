#!/usr/bin/env bun
/**
 * #1449 round 2 — a carried verdict's ledger write reports where it landed.
 *
 * Split from `test-auto-delta-carry.ts` for the AGENTS.md §12 500-line gate.
 * That suite asks whether an empty automatic delta is CARRIED; these two arms
 * ask what the carry's own ledger write REPORTS about itself, which is a
 * different module's contract (`writeCarriedEntry`, lens-review-auto-delta.ts).
 *
 * The bug these pin: `writeCarriedEntry` read `entry.writtenTo` off the object IT
 * handed to `appendLedgerEntry`, but that function stamps a NEW object
 * (`{ ...entry, writtenTo: … }`) and leaves the caller's alone. So the field was
 * `undefined` for the whole life of the carry, and every redirected carry
 * reported `{ recorded: true }` with no path — byte-identical to an ordinary
 * write. The caller (`lens-review-diff.ts` 5b) then told the operator a verdict
 * had been carried onto the ledger the merge guard reads, when the row had gone
 * into a file it will never open: the exact false statement #1449 exists to
 * remove, restored on the one write path that read its own entry.
 *
 * `lens-ledger.ts` has always read the stamped holder. These arms are what make
 * the two writers agree by assertion rather than by coincidence.
 *
 * Fixture + isolation come from `lib/auto-delta-fixture.ts` (the ledger override
 * pins every write to a temp file; nothing here touches a real `.git`).
 */
import { execSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { cleanup, mergeMainFixture, writeLedger } from "./lib/auto-delta-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { decideEmptyDelta } = await import("../src/lens-review-auto-delta.ts");
const { writeCarriedEntry } = await import("../src/lens-review-auto-delta.ts");
const { latestEntry, readLedgerAt } = await import("../src/review-ledger.ts");

const branch = "feature/work";

/** The clone's OWN ledger path — where the #912 guard looks. */
function ledgerFileOf(repo: string): string {
  const common = execSync("git rev-parse --git-common-dir", {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, "review-ledger.json");
}

/** The identity the REAL writer computes at `sha`, so the carry is decidable. */
async function identityAt(dir: string, sha: string) {
  const { workingTreePatchId } = await import("../src/review-ledger.ts");
  const { execp } = await import("../src/exec.ts");
  await execp(`git checkout -q ${sha}`, { cwd: dir });
  const w = await workingTreePatchId(execp, dir, { digest: true });
  await execp("git checkout -q feature/work", { cwd: dir });
  if (!w.patchId || !w.diffSha256) throw new Error(`writer produced no identity at ${sha}`);
  return { patchId: w.patchId, diffSha256: w.diffSha256 };
}

/** A real bare `origin` with origin/HEAD → main, so `<remote>/<mainline>` resolves
 * the way it does in production. */
async function addOrigin(dir: string): Promise<void> {
  const { execp } = await import("../src/exec.ts");
  const bare = path.join(path.dirname(dir), "origin.git");
  await execp(
    `git clone -q --bare ${dir} ${bare} && git remote add origin ${bare} && git fetch -q origin && git remote set-head origin main`,
    { cwd: dir, shell: "/bin/bash" },
  );
}

/** Branch last reviewed at c2 with an APPROVED verdict; HEAD is the merge of
 * main (an empty automatic delta), so the carry is decidable from real git. */
async function carryFixture() {
  const r = await mergeMainFixture();
  await addOrigin(r.dir);
  const { patchId, diffSha256 } = await identityAt(r.dir, r.c2);
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId,
      diffSha256,
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2,
      round: 1,
    },
  ]);
  return r;
}

// (J) a carry whose ledger write is REDIRECTED reports the redirect.
{
  const r = await carryFixture();
  // Point the override at a file OUTSIDE the clone's git dir — the #1449 shape
  // (an inherited `PI_ENSEMBLE_REVIEW_LEDGER_FILE`). The recorded row is COPIED
  // into it: `decideEmptyDelta` reads the ledger through the same
  // override-honouring resolver the writer writes through (that agreement IS the
  // #1449 bug), so the carry is decided from the file the row lands in, exactly
  // as a real leak decides. Leaving the row in the original file would not make
  // the arm stricter — the decision would find no prior entry, answer `full`,
  // and every assertion below would be unreachable.
  const elsewhere = path.join(path.dirname(r.dir), "carried-elsewhere.json");
  copyFileSync(r.ledgerFile, elsewhere);
  const previousOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = elsewhere;
  try {
    const e = await decideEmptyDelta({ cwd: r.dir, branch, head: r.merge, base: "main" });
    assert(e.kind === "carry", "a redirected carry is still DECIDED as a carry");
    if (e.kind !== "carry") throw new Error("arm requires a carry decision");
    const written = await writeCarriedEntry(r.dir, e.prev, r.merge, e.from);
    assert(written.recorded === true, "the redirected carry write itself succeeded");
    assert(
      written.recorded === true && typeof written.landedAtPath === "string",
      `#1449 the carry outcome carries the path the row landed at (${JSON.stringify(written)}) — reading entry.writtenTo instead of the stamped holder leaves this undefined`,
    );
    assert(
      written.recorded === true && written.landedAtPath === elsewhere,
      `#1449 the reported path is the overridden file, not the clone's ledger (${written.recorded === true ? written.landedAtPath : "n/a"})`,
    );
    // The outcome's path and the row's own stamp are the SAME string from the
    // SAME resolution — if they diverged, the note a reader saw would name a
    // file that does not contain the row.
    const carried = latestEntry(readLedgerAt(elsewhere), branch, "lens");
    assert(
      carried?.writtenTo === elsewhere && carried.carriedFrom === e.from,
      "#1449 the carried row stamps the path it actually landed at",
    );
    assert(
      latestEntry(readLedgerAt(r.ledgerFile), branch, "lens")?.headSha === r.c2,
      "#1449 the clone's ledger still holds only the pre-merge row — the guard cannot see the carry",
    );
  } finally {
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = previousOverride;
    rmSync(elsewhere, { force: true });
    cleanup(r.dir, r.ledgerFile);
  }
}

// (K) the converse: an ordinary carry reports NO path. This is the arm the
// write-side short-circuit and the realpath fallback are accountable to — the
// pre-fix blanket `catch { return false }` made one unresolvable side read as
// "different", so an ordinary write reported a redirect that had not happened.
//
// The override stays SET (to the clone's own ledger) rather than being deleted,
// for two reasons. (a) An UNSET override makes the resolver write the carry's
// row into the real `.git`, which the fixture cannot clean up — the shared-
// ledger pollution this suite forbids. (b) It is the stronger arm: an unset
// override short-circuits before the comparison, whereas this one RUNS the
// comparison — a second spelling of one file, in the clone's own git dir — and
// must still answer "not a redirect". The unset-override path is covered by
// `test-ledger-override-provenance.ts` arm 5, which runs the real writers with
// the env genuinely cleared against a temp clone.
{
  const r = await carryFixture();
  const home = ledgerFileOf(r.dir);
  copyFileSync(r.ledgerFile, home);
  const savedOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = home;
  try {
    const e = await decideEmptyDelta({ cwd: r.dir, branch, head: r.merge, base: "main" });
    assert(e.kind === "carry", "an override naming the clone's own ledger: still a carry");
    if (e.kind !== "carry") throw new Error("arm requires a carry decision");
    const written = await writeCarriedEntry(r.dir, e.prev, r.merge, e.from);
    assert(
      written.recorded === true &&
        (written as { landedAtPath?: string }).landedAtPath === undefined,
      `#1449 an ordinary carry reports no misdirection (${JSON.stringify(written)})`,
    );
  } finally {
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedOverride;
    cleanup(r.dir, r.ledgerFile);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
