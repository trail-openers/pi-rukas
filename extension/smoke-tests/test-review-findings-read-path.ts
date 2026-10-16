#!/usr/bin/env bun
/**
 * #1125 part 3 — the findings READ path takes its path from the caller that
 * resolved it, and a fail-closed read discloses like a fail-closed write.
 *
 * Three things the module-global ledger cache made untestable (and wrong):
 *
 *   1. Two rounds in one process with `PI_ENSEMBLE_REVIEW_LEDGER_FILE` changed
 *      between them read the SECOND file. A cache filled by the first `locate`
 *      served the first file to the second round, so a test (or an operator who
 *      re-points the override) silently reviewed against stale memory.
 *   2. `readBranchRows` (the prompt block's read) sees the same fresh path, so
 *      the lens prompt cannot be built from a file the round is not recording to.
 *   3. A findings file that exists but does not parse fails the round AND is
 *      copied aside, named in the reason, with the operator action attached —
 *      the same disclosure `mutateFindings` gives for a corrupt write. A read
 *      that fails silently is a round with no memory and no evidence of one.
 *
 * Offline: no Pi child is spawned; both ledgers are temp dirs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FINDINGS_FILE,
  findingsFileFor,
  readBranchRowsFailOpen,
  readBranchRowsRaw,
} from "../src/review-findings-read.ts";
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { setupReviewFixture } from "./lib/review-findings-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = ["// header", "function alpha() {", "  return 1;", "}", ""];
const prevLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const prevSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;

const fixture = setupReviewFixture({
  prefix: "findings-read-path",
  files: { "src/a.ts": `${SRC.join("\n")}\n` },
  report: () => [],
});

/** A row shaped like the store's own, on `branch`, citing line 3 of src/a.ts. */
function row(branch: string, id: string, title: string) {
  return {
    id,
    branch,
    path: "src/a.ts",
    anchor: "file",
    titleClass: "tc",
    title,
    severity: "MEDIUM",
    lens: "security",
    line: 3,
    snippetHash: "aaaaaaaaaaaaaaaa",
    lineHash: "bbbbbbbbbbbbbbbb",
    firstSeen: 1,
    lastSeen: 1,
    status: "open",
  };
}

try {
  const head = fixture.sh("git rev-parse HEAD");
  const fileA = path.join(fixture.ledgerDir, FINDINGS_FILE);
  // A second ledger dir in the same temp root: re-pointing the env var is the
  // only thing that separates the two rounds below.
  const dirB = path.join(path.dirname(fixture.ledgerDir), "ledger-b");
  mkdirSync(dirB, { recursive: true });
  const ledgerB = path.join(dirB, "review-ledger.json");
  const fileB = findingsFileFor(ledgerB);

  writeFileSync(
    fileA,
    JSON.stringify({ rows: [row("feat/x", "aaaa1111", "From ledger A")] }),
    "utf8",
  );
  writeFileSync(
    fileB,
    JSON.stringify({ rows: [row("feat/x", "bbbb2222", "From ledger B")] }),
    "utf8",
  );

  // Round 1 — the store resolves the fixture's ledger and reads file A.
  const first = await recordFindingRunOutcome({
    cwd: fixture.repo,
    branch: "feat/x",
    headSha: head,
    findings: [],
    review: "incomplete",
  });
  assert(
    first.ok === true,
    `round 1 records against the first ledger (${JSON.stringify(first.ok && "ok")})`,
  );
  const round1Rows = await readBranchRows(fixture.repo, "feat/x");
  assert(
    round1Rows.some((r) => r.title === "From ledger A"),
    "round 1's prompt read sees the file the round recorded to",
  );

  // Round 2 — the env var now names a DIFFERENT ledger. The read must follow it.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerB;
  const second = await recordFindingRunOutcome({
    cwd: fixture.repo,
    branch: "feat/x",
    headSha: head,
    findings: [],
    review: "incomplete",
  });
  assert(second.ok === true, "round 2 records against the re-pointed ledger");
  const round2Rows = await readBranchRows(fixture.repo, "feat/x");
  assert(
    round2Rows.some((r) => r.title === "From ledger B"),
    "changing PI_ENSEMBLE_REVIEW_LEDGER_FILE between rounds reads the NEW file",
  );
  assert(
    !round2Rows.some((r) => r.title === "From ledger A"),
    "the previous ledger's rows do not leak into the re-pointed round",
  );
  // The first file is untouched by the second round — proof the round acted on B.
  assert(
    readFileSync(fileA, "utf8").includes("From ledger A"),
    "the abandoned ledger is untouched by the re-pointed round",
  );

  // ── the read module takes a path, not a cwd, and never resolves one ────────
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerB;
  assert(
    readBranchRowsRaw(fileB, "feat/x")?.rows.length === 1,
    "readBranchRowsRaw reads the exact file it was handed",
  );
  assert(
    readBranchRowsFailOpen(fileB, "feat/x")?.length === 1,
    "readBranchRowsFailOpen reads the exact file it was handed",
  );
  assert(
    readBranchRowsFailOpen(undefined, "feat/x") === undefined,
    "no path at all is reported as no path, distinctly from an empty store",
  );
  assert(
    readBranchRowsFailOpen(path.join(dirB, "nope", FINDINGS_FILE), "feat/x")?.length === 0,
    "a missing ledger dir reads as no memory (fail open) rather than throwing",
  );

  // ── 3. a fail-closed read discloses like a fail-closed write ───────────────
  const broken = setupReviewFixture({
    prefix: "findings-read-corrupt",
    files: { "src/a.ts": `${SRC.join("\n")}\n` },
    report: () => [],
    withSkills: false,
  });
  try {
    const bFile = path.join(broken.ledgerDir, FINDINGS_FILE);
    const junk = "{ not json at all";
    writeFileSync(bFile, junk, "utf8");

    const out = await recordFindingRunOutcome({
      cwd: broken.repo,
      branch: "feat/x",
      headSha: broken.sh("git rev-parse HEAD"),
      findings: [],
      review: "full",
    });
    assert(
      out.ok === false,
      `a corrupt findings file fails the round (${JSON.stringify(out.ok && "recorded")})`,
    );
    const reason = out.ok === false ? out.reason : "";
    assert(
      reason.includes("could not be read"),
      `the refusal says the rows could not be read (${JSON.stringify(reason.slice(0, 80))})`,
    );
    assert(
      /\.corrupt-[0-9a-f]+/.test(reason),
      `the refusal names the copy it made (${JSON.stringify(reason.slice(0, 160))})`,
    );
    assert(
      reason.toLowerCase().includes("pi_ensemble_review_ledger_file") &&
        /repair|remove/i.test(reason),
      "the refusal ends with the operator action (repair/remove, or re-point the override)",
    );
    const copies = readdirSync(broken.ledgerDir).filter((f) =>
      f.startsWith(`${FINDINGS_FILE}.corrupt-`),
    );

    assert(
      // The one byte convention every copy-aside site shares: the bytes as read,
      // plus the trailing newline the helper appends. `.trim()` would let a copy
      // of anything else pass.
      copies.length === 1 &&
        readFileSync(path.join(broken.ledgerDir, copies[0] ?? ""), "utf8") === `${junk}\n`,
      "the bad file is copied aside with its bytes intact, same scheme as the write path",
    );
    assert(
      existsSync(bFile) && readFileSync(bFile, "utf8") === junk,
      "the original bad file is left in place for the operator to repair",
    );
    // The prompt block's read still fails OPEN: a lens prompt is not a decision.
    assert(
      (await readBranchRows(broken.repo, "feat/x")).length === 0,
      "the prompt read treats the corrupt file as no memory and does not throw",
    );

    // ── 4. present but UNREADABLE (EISDIR) is the same fail-closed disclosure ─
    // A directory where the findings file should be is not "no file": it exists,
    // it cannot be read, and a round that treated that as an empty store would
    // resolve every row the branch has. The reason must be the operator's repair
    // message naming the cause, not a raw OS error.
    const dirShape = setupReviewFixture({
      prefix: "findings-read-isdir",
      files: { "src/a.ts": `${SRC.join("\n")}\n` },
      report: () => [],
      withSkills: false,
    });
    try {
      const dFile = path.join(dirShape.ledgerDir, FINDINGS_FILE);
      mkdirSync(dFile);
      const dRound = await recordFindingRunOutcome({
        cwd: dirShape.repo,
        branch: "feat/x",
        headSha: dirShape.sh("git rev-parse HEAD"),
        findings: [],
        review: "full",
      });
      const dReason = dRound.ok === false ? dRound.reason : "";
      assert(dRound.ok === false, "an unreadable (directory) findings file fails the round");
      assert(
        dReason.includes("could not be read"),
        `the refusal says the rows could not be read (${JSON.stringify(dReason.slice(0, 80))})`,
      );
      assert(
        /repair or remove/i.test(dReason),
        `the refusal is the operator's repair message, not a bare OS error (${JSON.stringify(dReason.slice(0, 120))})`,
      );
      assert(
        /EISDIR|is a directory/i.test(dReason),
        `the refusal names the cause it hit (${JSON.stringify(dReason.slice(-160))})`,
      );
      assert(
        (await readBranchRows(dirShape.repo, "feat/x")).length === 0,
        "the prompt read treats the unreadable file as no memory and does not throw",
      );
    } finally {
      dirShape.cleanup();
    }
  } finally {
    broken.cleanup();
  }
} finally {
  fixture.cleanup();
  if (prevLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevLedger;
  if (prevSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = prevSkills;
}

process.exit(exit);
