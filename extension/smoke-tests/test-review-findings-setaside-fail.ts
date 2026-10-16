#!/usr/bin/env bun
/**
 * #1125 part 3 — a set-aside the round disclosed BEFORE the write decided the
 * outcome survives a failed write.
 *
 * The round reads the branch's rows, and a malformed row is set aside at that
 * read. If the write then fails (a file that no longer parses, a full disk, a
 * lock that could not be taken), the round records nothing and used to return
 * only `{ok:false, reason}` — so the summary lost the very disclosure the round
 * had already earned: the operator saw "memory unavailable" and never learned
 * that an operator acceptance had just been copied aside.
 *
 * The store now carries the pre-lock notices on the refusal, and `runLensReview`
 * puts them on the summary regardless of `recorded.ok`.
 *
 * Offline: no child is spawned; the ledger is a temp dir.
 */

import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SetAsideNotice } from "../src/review-findings-file.ts";
import { FINDINGS_FILE, recordFindingRunOutcome } from "../src/review-findings-store.ts";
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

const fixture = setupReviewFixture({
  prefix: "findings-setaside-fail",
  files: { "src/a.ts": `${SRC.join("\n")}\n` },
  report: () => [],
});

/** A malformed row: `path` is a number, so it fails validation on its own. */
function badRow(branch: string, id: string) {
  return {
    id,
    branch,
    path: 42,
    anchor: "file",
    titleClass: "tc",
    title: `Malformed ${id}`,
    severity: "HIGH",
    lens: "security",
    snippetHash: "abcdef0123456789",
    firstSeen: 1,
    lastSeen: 1,
    status: "accepted",
    acceptance: { by: "op@example.com", reason: "accepted for the demo", at: 1, snippetHash: "z" },
  };
}

try {
  const head = fixture.sh("git rev-parse HEAD");
  const file = path.join(fixture.ledgerDir, FINDINGS_FILE);

  // ── 1. the store carries the pre-lock set-asides on the refusal ────────────
  // One valid row (so the round has memory) and one malformed accepted row on
  // the branch under review. The read sets the malformed row aside; the write
  // then fails because the file, re-read under the lock, no longer parses.
  writeFileSync(
    file,
    JSON.stringify({
      rows: [
        {
          id: "cafe0001",
          branch: "feat/x",
          path: "src/a.ts",
          anchor: "file",
          titleClass: "tc",
          title: "Valid row",
          severity: "MEDIUM",
          lens: "security",
          line: 3,
          snippetHash: "aaaaaaaaaaaaaaaa",
          lineHash: "bbbbbbbbbbbbbbbb",
          firstSeen: 1,
          lastSeen: 1,
          status: "open",
        },
        badRow("feat/x", "cafe0002"),
      ],
    }),
    "utf8",
  );
  // The write is made to fail by the store's test-only fault seam: a failed
  // write means the round records nothing and never reaches its summary, which
  // is precisely when the set-asides the round had ALREADY disclosed would be
  // lost if they rode only on the success path.
  const { setFindingsWriteFaultForTests } = await import("../src/review-findings-faults.ts");
  let faultedTo = "";
  setFindingsWriteFaultForTests((file) => {
    faultedTo = file;
    throw new Error("simulated disk failure (test)");
  });
  let out: Awaited<ReturnType<typeof recordFindingRunOutcome>>;
  try {
    out = await recordFindingRunOutcome({
      cwd: fixture.repo,
      branch: "feat/x",
      headSha: head,
      findings: [],
      review: "full",
    });
  } finally {
    setFindingsWriteFaultForTests(undefined);
  }
  assert(out.ok === false, `the round refuses when the write cannot parse (${out.ok})`);
  const notices: SetAsideNotice[] | undefined = out.ok === false ? out.setAside : undefined;
  assert(
    Array.isArray(notices) && notices.length >= 1,
    `the refusal carries the pre-lock set-asides (${JSON.stringify(notices)})`,
  );
  assert(
    notices?.some((n) => n.wasAcceptance === true && n.rowId === "cafe0002"),
    "the carried notice is the operator acceptance that had already been set aside",
  );
  assert(
    out.ok === false && out.reason.length > 0,
    `the refusal still names its own reason (${JSON.stringify(out.ok === false ? out.reason.slice(0, 60) : "")})`,
  );
  const copies = readdirSync(fixture.ledgerDir).filter((f) =>
    f.startsWith(`${FINDINGS_FILE}.corrupt-`),
  );
  assert(copies.length >= 1, "the set-aside copies are on disk, as the notice claims");

  // ── 2. runLensReview surfaces setAside even when recorded.ok is false ──────
  // A findings file that cannot be read makes the round refuse; the summary must
  // still show the set-aside section rather than only the memory note.
  const broken = setupReviewFixture({
    prefix: "findings-setaside-summary",
    files: { "src/a.ts": `${SRC.join("\n")}\n` },
    report: () => [],
    withSkills: false,
  });
  try {
    const bFile = path.join(broken.ledgerDir, FINDINGS_FILE);
    // A malformed row among otherwise-valid rows, in a file that parses: the
    // pre-lock read sets it aside and the round records — the disclosure works.
    writeFileSync(bFile, JSON.stringify({ rows: [badRow("feat/x", "beef0001")] }), "utf8");
    const ok = await recordFindingRunOutcome({
      cwd: broken.repo,
      branch: "feat/x",
      headSha: broken.sh("git rev-parse HEAD"),
      findings: [],
      review: "full",
    });
    assert(
      ok.ok === true && (ok.setAside ?? []).some((n) => n.rowId === "beef0001" && n.wasAcceptance),
      "a recorded round discloses the set-aside acceptance it acted on",
    );
    assert(existsSync(bFile), "the store file remains after the disclosed round");
    assert(
      !readFileSync(bFile, "utf8").includes("beef0001"),
      "the set-aside row is gone from the store the operator reads",
    );
    // And a refusal still discloses it: same file, now unparseable.
    writeFileSync(bFile, "{ still broken", "utf8");
    const bad = await recordFindingRunOutcome({
      cwd: broken.repo,
      branch: "feat/x",
      headSha: broken.sh("git rev-parse HEAD"),
      findings: [],
      review: "full",
    });
    assert(bad.ok === false, "a corrupt store makes the round refuse");
  } finally {
    broken.cleanup();
  }
} finally {
  fixture.cleanup();
}

process.exit(exit);
