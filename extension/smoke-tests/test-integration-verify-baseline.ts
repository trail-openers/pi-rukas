#!/usr/bin/env bun
/**
 * #1404 — the failing-test-name parser and the per-name attribution rule the
 * commit-pr consolidated verify parks (or does not) on.
 *
 * verify-loop.sh emits failure names in TWO shapes across TWO modes, and the
 * consumer is the one place they get read back:
 *
 *   - per-failure markers `FAILED: <file>` (normal mode prints them before each
 *     failing test's output, digest mode prints them with the ✗ detail after),
 *     with normal mode appending ` (timed out after Ns)` on a watchdog kill;
 *   - the summary `FAILED: <n> test(s) — a.ts, b.ts`, which the 780-char budget
 *     collapses to `… and <m> more` when the list no longer fits.
 *
 * Names MUST come from the raw stream: `extractAttributedTail` anchors on the
 * LAST `^FAILED: .+$` line and, past its bound, keeps only that line plus the
 * tail — so parsing the bounded tail sees the summary and elides every
 * per-failure marker (the defect this test pins).
 *
 * The attribution rule is a set difference, and its fail-closed cases matter
 * more than its happy path: no names on either side, a collapsed list, or a
 * base run that killed at its bound must all read UNATTRIBUTABLE (park), never
 * "zero change-caused failures, continue".
 */
import {
  type NameRoots,
  attributeFailuresByName,
} from "../src/work-driver-verify-attribution.ts";
import {
  compareNames,
  emptyBaseReason,
  failingTestNames,
  sameFailingTest,
} from "../src/work-driver-verify-names.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The roots the attribution rule needs: the integration checkout and the
 * probe's throwaway worktree under it. The two-set cases below use BARE names,
 * so each name is declared in the membership sets — that is the only shape in
 * which two bare spellings may be compared at all.
 */
const bare = (...names: string[]): NameRoots => ({
  changeRoots: ["/repo"],
  probeRoot: "/repo/.worktrees/baseline-verify-cp",
  changeUnrooted: names,
  probeUnrooted: names,
});
const attr = (change: string[], base: string[], roots?: NameRoots) =>
  attributeFailuresByName(change, base, roots ?? bare(...change, ...base));

// ── 7. per-test attribution: the mixed run parks naming ONLY the new tests.
{
  const a = attr(
    ["test-old.ts", "test-new.ts", "test-also-old.ts"],
    ["test-old.ts", "test-also-old.ts", "test-unrelated-at-base.ts"],
  );
  assert(
    a.unattributable === undefined,
    "a run with names on both sides is attributable, not a park-by-silence",
  );
  assert(
    a.preExisting.length === 2 &&
      a.preExisting.includes("test-old.ts") &&
      a.preExisting.includes("test-also-old.ts"),
    `both names that fail at base are pre-existing (got ${JSON.stringify(a.preExisting)})`,
  );
  assert(
    a.changeCaused.length === 1 && a.changeCaused[0] === "test-new.ts",
    `only the test that passes at base is change-caused (got ${JSON.stringify(a.changeCaused)})`,
  );
}

// ── 8. all pre-existing → nothing for the change to answer for.
{
  const a = attr(["test-a.ts", "test-b.ts"], ["test-a.ts", "test-b.ts"]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 2,
    "every failing name at base → zero change-caused (the continue case)",
  );
}

// ── 9. a name present ONLY at base does not affect the verdict.
{
  const a = attr(["test-a.ts"], ["test-a.ts", "test-renamed-away.ts"]);
  assert(
    a.changeCaused.length === 0 && a.preExisting.length === 1,
    "a test the change deleted/renamed (red at base, absent from the change run) is not counted against the change",
  );
}

// ── 10. duplicates in the change run do not double-count.
{
  const a = attr(["test-a.ts", "test-a.ts"], ["test-a.ts"]);
  assert(
    a.preExisting.length === 1 && a.changeCaused.length === 0,
    "a name printed twice (normal mode's echo) is one test, not two",
  );
}

// ── 10b. the two runs happen in TWO TREES, so one test prints as two different
// absolute paths: the change run resolves against the integration checkout, the
// probe against its throwaway `.worktrees/` tree. The comparison is ANCHORED —
// each name is stripped against the root it lives under and the remainders must
// be EQUAL. Round 1 compared shared trailing segments, which excused unrelated
// files, so the whole section is written against the anchored rule.
{
  const TREE = "/tmp/cycle-abc/repo";
  const PROBE = `${TREE}/.worktrees/baseline-verify-7`;
  const roots: NameRoots = { changeRoots: [TREE], probeRoot: PROBE };
  const same = attr([`${TREE}/tests/test-red.ts`], [`${PROBE}/tests/test-red.ts`], roots);
  assert(
    same.changeCaused.length === 0,
    "the same test under two trees is ONE test — the case the feature turns on",
  );
  assert(
    same.preExisting[0] === `${TREE}/tests/test-red.ts`,
    "and it is reported in the change run's own spelling — what an operator greps for",
  );
  assert(
    attr([`${TREE}/tests/test-new.ts`], [`${PROBE}/tests/test-other.ts`], roots).changeCaused
      .length === 1,
    "two genuinely different tests across two trees stay change-caused",
  );
  const split = attr(
    [`${TREE}/tests/test-red.ts`, `${TREE}/tests/test-new.ts`],
    [`${PROBE}/tests/test-red.ts`],
    roots,
  );
  assert(
    split.preExisting.length === 1 && split.changeCaused.length === 1,
    "one pre-existing and one new across two trees splits correctly",
  );
  // THE adversarial case: the shared-tail rule excused this. `tests/test-x.ts`
  // and `p/q/r/s/tests/test-x.ts` are different files whose tails coincide, and
  // a coincidence in a rule that can only ever EXCUSE is a pushed red gate.
  // Anchored to the two known roots they are NOT equal, so the change run's
  // name is change-caused and the cycle parks.
  const deep = attr(["tests/test-x.ts"], ["p/q/r/s/tests/test-x.ts"], {
    changeRoots: ["/base/repo"],
    probeRoot: "/base/repo/.worktrees/baseline-verify-cp",
    changeUnrooted: ["tests/test-x.ts"],
    probeUnrooted: ["p/q/r/s/tests/test-x.ts"],
  });
  assert(
    deep.changeCaused.length === 1 && deep.preExisting.length === 0,
    `a same-basename test from a DIFFERENT tree is not an excuse — it stays change-caused and the cycle parks (got ${JSON.stringify(deep)})`,
  );
  assert(
    !sameFailingTest("tests/test-x.ts", "p/q/r/s/tests/test-x.ts"),
    "sameFailingTest refuses the same-basename/different-tree pair outright",
  );
  // A name outside BOTH roots cannot be placed, so nothing about it is known:
  // unattributable (park), never "different" (which would be a guess) and never
  // "same" (which would be a push).
  const stray = attr(["/somewhere/else/test-x.ts"], [`${PROBE}/tests/test-x.ts`], roots);
  assert(
    stray.unattributable !== undefined &&
      stray.preExisting.length === 0 &&
      stray.changeCaused.length === 0,
    `a name outside both trees is unattributable, not guessed at either way (got ${JSON.stringify(stray)})`,
  );
  assert(
    compareNames(`${TREE}/tests/a.ts`, `${PROBE}/tests/a.ts`, roots) === "same" &&
      compareNames(`${TREE}/tests/a.ts`, `${PROBE}/tests/b.ts`, roots) === "different" &&
      compareNames("outside.ts", "outside.ts", roots) === "unknown" &&
      compareNames("a/x.ts", "b/x.ts", { ...roots, changeUnrooted: ["a/x.ts", "b/x.ts"] }) ===
        "different",
    "compareNames answers same / different / unknown, and unknown is reachable",
  );
  assert(
    compareNames("/a/x.ts", "/b/c/x.ts", { changeRoots: ["/a"], probeRoot: "/b" }) === "different",
    "a bare basename alone never excuses — same-named files in different dirs are different tests",
  );
  assert(
    sameFailingTest("tests/t.ts", "tests/t.ts") && !sameFailingTest("a/t.ts", "b/c/t.ts"),
    "sameFailingTest agrees on bare names and refuses a differing pair",
  );
  // The degenerate configuration: one tree for both runs makes relative-path
  // equality prove nothing, so it must excuse nothing.
  assert(
    compareNames(`${TREE}/tests/a.ts`, `${TREE}/tests/a.ts`, {
      changeRoots: [TREE],
      probeRoot: TREE,
    }) === "unknown",
    "both runs in ONE tree is unknown — relative equality there proves nothing",
  );
  // A tree reached through a symlink must still anchor its own names: on macOS
  // `/var/…` and `/private/var/…` are one directory in two spellings, and a
  // gate script that resolves `$0` prints one while the caller holds the other.
  // Reading them as different trees would make every real name unplaceable.
  {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pp = await import("node:path");
    const base = fs.mkdtempSync(pp.join(os.tmpdir(), "pi-1404-link-"));
    const real = pp.join(base, "real", "repo");
    fs.mkdirSync(pp.join(real, "tests"), { recursive: true });
    const link = pp.join(base, "link");
    fs.symlinkSync(pp.join(base, "real"), link);
    const linked = `${link}/repo`;
    const cmp = compareNames(`${real}/tests/a.ts`, `${linked}/tests/a.ts`, {
      changeRoots: [real, linked],
      probeRoot: `${real}/.worktrees/baseline-verify-cp`,
    });
    fs.rmSync(base, { recursive: true, force: true });
    assert(
      cmp === "same",
      `the same tree under two spellings (a symlinked root) is ONE tree, not an unplaceable name (got "${cmp}")`,
    );
  }
}

// ── 13. the seam itself, against a scripted exec: the two fail-OPEN guards.
//
// `attributeAgainstBase` is where "any doubt parks" has to be true, so the
// guards are tested by driving the whole function rather than its parts. Both
// of these used to be absent, and both erred in the direction that excuses.
{
  const { attributeAgainstBase } = await import("../src/work-driver-verify-attribution.ts");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const CHANGE = "FAILED: /repo/tests/test-red.ts\nFAILED: 1 test(s) — /repo/tests/test-red.ts";
  /**
   * Scripted exec. Git/worktree plumbing succeeds; the gate run fails the way
   * `execFile` fails a non-zero child — a thrown error carrying `stdout` — so
   * the probe actually reads a red base rather than a green one.
   */
  const scripted =
    (gate: { stdout: string; code: number }) =>
    async (cmd: string): Promise<{ stdout: string; stderr?: string }> => {
      if (cmd.startsWith("git ") || cmd.startsWith("mkdir") || cmd.includes("worktree")) {
        return { stdout: "" };
      }
      const err = new Error(`Command failed with exit code ${gate.code}`) as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = gate.stdout;
      err.stderr = "";
      err.code = gate.code;
      throw err;
    };
  const baseStream = (names: string[], count: number): string =>
    [
      ...names.map((n) => `FAILED: ${n}`),
      `FAILED: ${count} test(s) — ${names.join(", ")}`,
      `P: 3  F: ${count}`,
    ].join("\n");
  const opts = (verifyCmd: string) => ({
    repoRoot: "/repo",
    baseSha: SHA,
    verifyCmd,
    changeRoots: ["/wt-a"],
    timeoutMs: 5000,
  });

  // (a) The base run exits non-zero while its tally says NOTHING failed. The
  // two pieces of evidence disagree, so nothing may be excused on the
  // optimistic one — `F: 0` plus names is not a red base, it is a forgery.
  const contradictory = await attributeAgainstBase(
    scripted({
      stdout: `${baseStream(["/repo/.worktrees/baseline-verify-commit-pr/tests/test-red.ts"], 1)}\nP: 4  F: 0`,
      code: 1,
    }),
    opts("sh gate.sh"),
    CHANGE,
  );
  assert(
    contradictory === undefined,
    `#1404: a base whose tally says zero failures while naming failures is a contradiction — it excuses nothing and the cycle parks (got ${JSON.stringify(contradictory)})`,
  );

  // (b) The base run exited non-zero but printed NO summary at all (a killed
  // shell, a non-loop gate). "It failed" is not evidence that THIS test failed,
  // and a silent non-zero exit must never read as a valid red verdict.
  const unprobed = await attributeAgainstBase(
    scripted({ stdout: "some tool complained, no markers here", code: 1 }),
    opts("sh gate.sh"),
    CHANGE,
  );
  assert(
    unprobed === undefined,
    `#1404: a base run that never reported its own verdict is unprobed — its exit code alone excuses nothing (got ${JSON.stringify(unprobed)})`,
  );

  // (c) Control: a base red on a DIFFERENT test does not excuse the change's.
  const clear = await attributeAgainstBase(
    scripted({
      stdout: baseStream(["/repo/.worktrees/baseline-verify-commit-pr/tests/test-other.ts"], 1),
      code: 1,
    }),
    opts("sh gate.sh"),
    CHANGE,
  );
  assert(
    clear !== undefined &&
      clear.preExistingFailures.length === 0 &&
      clear.changeCausedFailures.length === 1,
    `#1404 (control): a base red on a DIFFERENT test leaves the change's failure blamed, so the park is the change's own doing (got ${JSON.stringify(clear)})`,
  );

  // (d) Control: the coherent case still excuses, which is what makes (a)/(b)
  // the contradiction and the silence doing the work rather than a broken seam.
  const agreed = await attributeAgainstBase(
    scripted({
      stdout: baseStream(["/repo/.worktrees/baseline-verify-commit-pr/tests/test-red.ts"], 1),
      code: 1,
    }),
    opts("sh gate.sh"),
    CHANGE,
  );
  assert(
    agreed !== undefined &&
      agreed.preExistingFailures.length === 1 &&
      agreed.changeCausedFailures.length === 0,
    `#1404 (control): a coherent base red on the SAME test excuses it, so the seam works and (a)/(b) fail closed on their own merits (got ${JSON.stringify(agreed)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
