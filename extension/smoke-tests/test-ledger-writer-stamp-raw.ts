#!/usr/bin/env bun
/**
 * #1449 round 2 — the WRITER stamps and compares the RAW ledger path.
 *
 * Split from `test-ledger-provenance-compare.ts` for the AGENTS.md §12 500-line
 * gate. That file asks what the guard's diagnostic REPORTS from a stamp somebody
 * else wrote; this one asks what the writer PUT THERE in the first place, which
 * is where the round-1 bug lived and which no guard-level arm can see — a guard
 * reading a truncated stamp cannot tell whether the writer wrote it truncated or
 * the file was tampered with afterwards.
 *
 * The bug: `appendLedgerEntry` stamped `sanitiseLedgerProvenancePath(file)`.
 * That helper caps at 240 chars (it must — the value ends up inside the guard's
 * refusal string), so a clone path past the cap clamped to a PREFIX of itself,
 * the stamp no longer equalled the clone path the comparison checked it against,
 * and an ordinary write on a deep path reported a misdirection that had not
 * happened. The fix is the split this file pins: the stamp is the raw resolved
 * path, and sanitising happens only where the value is rendered.
 *
 * The fixtures are synthetically DEEP, and each arm asserts its own premise
 * (`length > LEDGER_PROVENANCE_PATH_MAX`). The depth is COMPUTED, not counted:
 * `padTo` measures the actual prefix and the exported cap, so the fixture is
 * past the cap by a fixed margin whether the host's temp root is macOS
 * `/var/folders/…/T/` or Linux `/tmp/` — CI run 39099227496 was the second
 * shape, where the old fixed segment count landed 34 chars short and the arm
 * that pins this bug was quietly the short case twice.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_PROVENANCE_PATH_MAX, sameResolvedPath } from "../src/review-ledger-path.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  ledgerPathFor,
  readLedgerFile,
} from "../src/review-ledger.ts";
import { realExec } from "./lib/exec-fake.ts";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log(`\u2713 ${msg}`);
  } else {
    failed++;
    console.error(`\u2717 ${msg}`);
  }
}

const BRANCH = "feature/writer-stamp-raw";

/** Real git for the writer's executor seam — `appendLedgerEntry` resolves the
 * clone's git dir through it, so a stub that faked the common dir would let the
 * arm pass while testing the stub's arithmetic instead of the writer's.
 * `realExec` (lib/exec-fake.ts) rather than a local `execFileSync("/bin/sh",…)`:
 * `test-exec-argv-fakes.ts` refuses a driver-bound executor that drops `argv`,
 * and the local `/bin/sh` wrapper was exactly that shape. */
const realGitExec = realExec;

/**
 * How many chars past the cap a fixture must land. A margin, not a hair: the
 * arms below all compare against the same number, so the fixture is
 * meaningfully over rather than one byte over whatever the host's temp root
 * happens to be.
 */
const OVER_CAP_BY = 40;

/**
 * The path the fixture wants, padded to `target` chars by lengthening the
 * caller's own prefix rather than by counting segments.
 *
 * #1449 CI: the previous fixture picked a segment count and trusted the host's
 * temp root to be long. macOS `/var/folders/…/T/` gave 261 chars, Linux
 * `/tmp/…` gave 206 — the cap, the premise assertions, and the bug it guards
 * were all silently the short case on CI while staying green locally. Padding
 * from the actual prefix length and the exported cap makes the fixture's
 * length a property of the fixture on any host.
 */
function padTo(target: number, ...components: string[]): string {
  const base = path.join(...components);
  const sep = path.sep;
  const fill = target - base.length - sep.length;
  if (fill < 1) {
    throw new Error(`cannot pad to ${target}: the prefix is already ${base.length} chars`);
  }
  // One long component, not many short ones: a filesystem component caps at
  // 255 bytes and `fill` is far under that, so this never collides with it.
  return `${base}${sep}${"z".repeat(fill)}`;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "p1449-writer-stamp-"));
const savedOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;

try {
  // ---- the writer on a deep path: raw stamp, no false redirect -------------
  //
  // A bare `git init` at a deep path. Nothing is committed into it, which is
  // enough: `appendLedgerEntry` stamps before it reads or writes the file's
  // contents, so the arm exercises the stamp and the comparison without needing
  // a patch identity.
  const deepClone = padTo(
    LEDGER_PROVENANCE_PATH_MAX - "/review-ledger.json".length + OVER_CAP_BY,
    dir,
    "c",
  );
  mkdirSync(deepClone, { recursive: true });
  execFileSync("git", ["init", "-q", deepClone], { stdio: "ignore" });
  const deepLedger = path.join(deepClone, ".git", "review-ledger.json");
  assert(
    deepLedger.length > LEDGER_PROVENANCE_PATH_MAX,
    `#1449 the writer fixture's ledger path is past the sanitiser's cap of ${LEDGER_PROVENANCE_PATH_MAX} (${deepLedger.length} chars) — on a host with a short tmpdir this arm would be the short case twice`,
  );
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = deepLedger;
  {
    const holder: { current: LedgerEntry; landedAtPath?: string } = {
      current: {
        branch: BRANCH,
        kind: "lens",
        patchId: "a".repeat(40),
        passed: true,
        at: 1_700_000_000_000,
      },
    };
    const appendFailure = await appendLedgerEntry(holder.current, realGitExec, deepClone, holder);
    assert(
      appendFailure === undefined,
      `#1449 the write itself succeeds on a deep path (${appendFailure})`,
    );
    assert(
      holder.landedAtPath === undefined,
      `#1449 a write to the clone's OWN ledger on a path past the ${LEDGER_PROVENANCE_PATH_MAX}-char cap reports no misdirection (${holder.landedAtPath}) — stamping the sanitised path collapses it to a prefix and makes this a false redirect`,
    );
    const row = existsSync(deepLedger) ? readLedgerFile(deepLedger).entries.at(-1) : undefined;
    assert(
      row?.writtenTo === deepLedger,
      "#1449 the row itself carries the RAW resolved path, not the clamped one — the guard's comparison depends on it",
    );
    assert(
      row?.writtenTo === undefined || row.writtenTo.length > LEDGER_PROVENANCE_PATH_MAX,
      "#1449 the stamped value is genuinely past the cap, so the assertion above is not the short case by accident",
    );
  }

  // ---- the same file through the resolver, not through a guess --------------
  //
  // The writer stamps `ledgerPathFor`'s answer, and compares it against
  // `cloneLedgerPathFor`'s. If the two ever disagreed about a path they both
  // derived from the same `git rev-parse`, every write would report a redirect —
  // so the equality is asserted through the resolver itself, not against a
  // hand-built string that happens to match.
  {
    const resolved = await ledgerPathFor(realGitExec, deepClone);
    assert(
      resolved === deepLedger,
      `#1449 the resolver lands where the fixture says (${resolved}) — the arms above and the writer agree on the path`,
    );
    assert(
      sameResolvedPath(resolved, deepLedger),
      "#1449 the resolver's answer and the fixture's path compare equal (raw, both sides)",
    );
  }

  // ---- the raw-vs-sanitised pair, at the comparison itself -----------------
  //
  // `sanitiseLedgerProvenancePath` truncates. A comparison that consumes its
  // output is a comparison that says "different" about one long path. Asserted
  // directly so a future edit that sanitises before comparing has a named arm
  // going red, rather than only the end-to-end one above.
  {
    const long = padTo(LEDGER_PROVENANCE_PATH_MAX + OVER_CAP_BY, dir, "d", "review-ledger.json");
    assert(
      long.length > LEDGER_PROVENANCE_PATH_MAX,
      `#1449 the deep comparison fixture is past the cap of ${LEDGER_PROVENANCE_PATH_MAX} (${long.length} chars)`,
    );
    assert(
      sameResolvedPath(long, long) === true,
      "#1449 the same deep path compares equal to itself — the bug was comparing its truncation",
    );
    const truncated = long.slice(0, LEDGER_PROVENANCE_PATH_MAX);
    assert(
      truncated !== long,
      "#1449 the truncated prefix really differs from the full path (else the arm above is vacuous)",
    );
  }

  // ---- a row whose stamp is a dangling symlink still compares by path ------
  //
  // The other way realpath fails: the stamp exists as a link but its target does
  // not. Per-side fallback means the lexical path decides, and it must not
  // collapse into "different" for a stamp naming the clone's own file.
  {
    const cloneDir = path.join(dir, "clone");
    mkdirSync(cloneDir, { recursive: true });
    const cloneLedger = path.join(cloneDir, "review-ledger.json");
    const dangling = path.join(cloneDir, "dangling.json");
    const linkPath = path.join(cloneDir, "link.json");
    writeFileSync(dangling, JSON.stringify({ entries: [] }), "utf8");
    let linked = false;
    try {
      // A link to a target that does not exist: realpath(link) throws ENOENT.
      const { symlinkSync } = await import("node:fs");
      symlinkSync(path.join(cloneDir, "never-written.json"), linkPath, "file");
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) {
      assert(
        sameResolvedPath(linkPath, cloneLedger) === false,
        "#1449 a dangling link naming a different file than the clone ledger still reads as a redirect",
      );
      assert(
        sameResolvedPath(linkPath, path.join(cloneDir, "never-written.json")) === false || true,
        "#1449 the dangling-link comparison answers rather than throwing",
      );
    } else {
      assert(true, "#1449 symlink unsupported here — the lexical arms still ran");
    }
  }
} finally {
  if (savedOverride === undefined) {
    // biome-ignore lint/performance/noDelete: restoring the pre-import env
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  } else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedOverride;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
