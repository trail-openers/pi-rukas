#!/usr/bin/env bun
/**
 * #1362 — the `.pi/dirty-root-exempt` parser and matcher, offline (no git).
 *
 * The list is the only way a project says "this repo-root file is a tool's
 * own, not dirt", so everything that decides it lives in one module and every
 * rule the issue's Settlements name is asserted here:
 *
 *   1. parsing: comments, blank lines, `./` stripping, trailing-slash
 *      normalisation, dedup.
 *   2. rejection WITH a trace: absolute, `..`, glob, empty-after-normalisation
 *      entries — each contributes nothing, none of them throws.
 *   3. an entry naming a PROTECTED path is rejected (`.pi/`, `.github/`,
 *      `CODEOWNERS`, `agents.json`): a project cannot list away the files that
 *      define how its own cycle is judged.
 *   4. matching: prefix + `/` boundary (`.claude` never matches `.claudefoo/x`),
 *      porcelain quoting removed, renames never exempt.
 *   5. the config file: absent → empty and SILENT; unreadable (non-ENOENT) →
 *      empty plus a trace; never a throw.
 *   6. two cycle contexts with different lists do not share exemptions — the
 *      list is a parameter, never module state, because up to
 *      PI_ENSEMBLE_PARALLEL_GROUPS cycles run in one process.
 */

// trace() reads PI_ENSEMBLE_DEBUG at module load, so the gate is on BEFORE the
// module under test is imported: a trace written while the gate was off would
// be swallowed, not merely uncollected.
process.env.PI_ENSEMBLE_DEBUG = "1";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The trace() lines this file cares about all name the config file's BASE
 *  name (the reader prefixes them with a constant, not the joined path), so
 *  that is the collector's marker. */
const EXEMPT_TRACE_MARKER = "dirty-root-exempt";
import {
  DIRTY_ROOT_EXEMPT_FILE,
  isConfiguredExemptDirtLine,
  matchesConfiguredExempt,
  parseDirtyRootExempt,
  readDirtyRootExempt,
} from "../src/work-driver-dirty-root-exempt.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Capture the `trace()` lines a call writes. trace() is gated on
 * PI_ENSEMBLE_DEBUG (set at the top of this file, before trace.ts is imported)
 * and writes to stderr, so stderr's write is swapped for a collector for the
 * duration of the call; every line is also passed through so a failure is
 * still visible in the run output.
 */
async function withTrace<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const captured: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const passthrough = (chunk: string) => original.call(process.stderr, chunk);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.includes(EXEMPT_TRACE_MARKER)) captured.push(s);
    else passthrough(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, lines: captured };
  } finally {
    process.stderr.write = original;
  }
}

const root = mkdtempSync(join(tmpdir(), "issue1362-exempt-"));

try {
  // ---- 1. parsing: the accepted shapes -------------------------------------
  {
    const { entries, rejected } = parseDirtyRootExempt(
      [
        "# a comment line",
        "",
        "   ",
        ".claude/",
        "./.vscode",
        "  .idea/  ",
        ".claude", // duplicate of the first after normalisation
        "notes/todo",
      ].join("\n"),
    );
    assert(
      entries.join(",") === ".claude,.vscode,.idea,notes/todo",
      `parsing keeps one normalised entry per distinct prefix (got ${JSON.stringify(entries)})`,
    );
    assert(
      rejected.length === 0,
      `parsing rejects none of the well-formed lines (got ${JSON.stringify(rejected)})`,
    );
  }

  // ---- 2. rejected entries: each contributes nothing, none throws ----------
  {
    const cases: [string, string][] = [
      ["/etc/passwd", "absolute"],
      ["../secrets", "parent-dir"],
      ["src/../.env", "parent-dir"],
      [".claude/*.json", "glob"],
      ["node_modules/[x]", "glob"],
      [".", "empty"],
      ["./", "empty"],
      // A leading `/` is absolute and is rejected as such — including a bare
      // `/`, which would otherwise also be "empty after normalisation". The
      // absolute test runs first, so `/` reports `absolute`, not `empty`; the
      // `empty` reason is what `.`, `./` and any other all-dot line reports.
      ["/", "absolute"],
      [".github/workflows", "protected"],
      [".pi/dirty-root-exempt", "protected"],
      ["CODEOWNERS", "protected"],
      ["agents.json", "protected"],
    ];
    for (const [line, reason] of cases) {
      const { entries, rejected } = parseDirtyRootExempt(line);
      assert(
        entries.length === 0 && rejected.length === 1 && rejected[0]?.reason === reason,
        `entry ${JSON.stringify(line)} is rejected (${reason}) and contributes nothing`,
      );
    }
    // One rejection never poisons the good lines beside it.
    const mixed = parseDirtyRootExempt(".claude\n../etc\n.envrc");
    assert(
      mixed.entries.join(",") === ".claude,.envrc" && mixed.rejected.length === 1,
      "a rejected line is skipped, the accepted ones beside it still apply",
    );
  }
  // The whole point: listing `.pi/` would hide a self-written grant from the
  // dirty-root gate, and listing `src/` would hide real uncommitted source
  // from staging. `.github/`, `.pi/`, CODEOWNERS and agents.json are refused;
  // a nested protected path is refused too, at any depth.
  for (const line of [".github", ".pi", "CODEOWNERS", "agents.json", "a/b/.github"]) {
    assert(
      parseDirtyRootExempt(line).entries.length === 0,
      `a protected path cannot be exempted: ${line}`,
    );
  }
  assert(
    parseDirtyRootExempt(".claude").entries.length === 1,
    "an ordinary path is still exemptible (the refusal is not a blanket ban)",
  );

  // ---- 4. matching: prefix + boundary, quoting, renames --------------------
  {
    const list = [".claude"];
    assert(matchesConfiguredExempt(".claude", list) === true, "an entry matches itself");
    assert(
      matchesConfiguredExempt(".claude/settings.local.json", list) === true,
      "an entry matches a path under it",
    );
    assert(
      matchesConfiguredExempt(".claudefoo/x", list) === false,
      "`.claude` does NOT match `.claudefoo/x` (the boundary is a `/`, not a prefix)",
    );
    assert(
      matchesConfiguredExempt('"\\303\\244"', list) === false,
      "a quoted path is unquoted before matching, not compared with its quotes",
    );
    assert(
      matchesConfiguredExempt("./.claude/x", list) === true,
      "a `./`-prefixed path matches the same entry",
    );
    assert(matchesConfiguredExempt("src/a.ts", []) === false, "an empty list matches nothing");
    assert(
      matchesConfiguredExempt("src/a.ts", undefined) === false,
      "an absent list matches nothing",
    );
    // Porcelain-line level: untracked only, and the `XY ` prefix is stripped.
    assert(
      isConfiguredExemptDirtLine("?? .claude/settings.local.json", list) === true,
      "an untracked porcelain line under an exempt prefix is not dirt",
    );
    assert(
      isConfiguredExemptDirtLine('?? ".claude/settings.local.json"', list) === true,
      "porcelain quoting is removed before matching a dirt line",
    );
    assert(
      isConfiguredExemptDirtLine(" M .claude/settings.json", list) === false,
      "a MODIFIED tracked file under an exempt prefix is still dirt",
    );
    assert(
      isConfiguredExemptDirtLine("A  .claude/new.json", list) === false,
      "a staged new file under an exempt prefix is still dirt",
    );
    assert(
      isConfiguredExemptDirtLine(" D .claude/gone.json", list) === false,
      "a deleted tracked file under an exempt prefix is still dirt",
    );
    assert(
      isConfiguredExemptDirtLine("R  .claude/x.ts\0a/x.ts", list) === false,
      "a rename INTO an exempt prefix is dirt (a rename is never `??`)",
    );
    assert(
      isConfiguredExemptDirtLine("?? .claudefoo/x", list) === false,
      "an untracked line beside the prefix, not under it, is dirt",
    );
    assert(
      isConfiguredExemptDirtLine("?? .claude/x", []) === false,
      "with no list, no porcelain line is exempt (byte-identical to before)",
    );
    // #1362 fix round — the one code that MUST stay unexempted: a staged NEW
    // file the cycle wrote under an exempt prefix. Its code is `A`, not `??`, so
    // the dirt gates and the restore's claim both keep treating it as the
    // cycle's work rather than as a tool's stray. `restore-entry.ts`'s
    // `markExemptCandidates` deliberately skips it for the same reason; were it
    // to match on `code === "??"` alone, this line's shape is exactly what the
    // stash would swallow and the claim would omit.
    assert(
      isConfiguredExemptDirtLine("A  .claude/generated-by-the-cycle.json", list) === false,
      "a STAGED NEW file under an exempt prefix is not exempt (its `A` code is what marks it the cycle's own)",
    );
  }

  // ---- 5. the config file: absent silent, unreadable traced, never throws --
  {
    const absent = join(root, "absent");
    mkdirSync(absent, { recursive: true });
    const r1 = await withTrace(() => readDirtyRootExempt(absent));
    assert(
      r1.value.entries.length === 0 && r1.value.readFailed === undefined && r1.lines.length === 0,
      "no .pi/dirty-root-exempt → an empty list, NO readFailed and NO trace (the default for every project)",
    );

    const good = join(root, "good");
    mkdirSync(join(good, ".pi"), { recursive: true });
    writeFileSync(join(good, DIRTY_ROOT_EXEMPT_FILE), "# tool-local files\n.claude/\n");
    const r2 = await withTrace(() => readDirtyRootExempt(good));
    assert(
      r2.value.entries.join(",") === ".claude" && r2.value.readFailed === undefined,
      `the file is read from repoRoot's working tree (got ${JSON.stringify(r2.value)})`,
    );

    const bad = join(root, "bad");
    mkdirSync(join(bad, ".pi"), { recursive: true });
    // A DIRECTORY where the file should be: EISDIR, not ENOENT — the "unreadable"
    // branch the acceptance criteria require to be empty PLUS a trace.
    writeFileSync(join(bad, DIRTY_ROOT_EXEMPT_FILE), "placeholder");
    rmSync(join(bad, DIRTY_ROOT_EXEMPT_FILE));
    mkdirSync(join(bad, DIRTY_ROOT_EXEMPT_FILE));
    const r3 = await withTrace(() => readDirtyRootExempt(bad));
    assert(
      r3.value.entries.length === 0,
      "an unreadable config yields an empty list — a broken config never throws",
    );
    assert(
      r3.lines.length > 0,
      `an unreadable config (non-ENOENT) says so in a trace (got ${JSON.stringify(r3.lines)})`,
    );
    // #1362 fix round — the trace goes to stderr and nowhere else. A cycle that
    // then blocks on residue must be able to say WHY in its handoff, so the
    // failure also comes back to the caller as data.
    assert(
      typeof r3.value.readFailed === "string" && r3.value.readFailed.includes("EISDIR"),
      `an unreadable config reports readFailed so the handoff can name it (got ${JSON.stringify(r3.value.readFailed)})`,
    );

    const denied = join(root, "denied");
    mkdirSync(join(denied, ".pi"), { recursive: true });
    writeFileSync(join(denied, DIRTY_ROOT_EXEMPT_FILE), ".claude\n");
    chmodSync(join(denied, DIRTY_ROOT_EXEMPT_FILE), 0o000);
    if (process.getuid?.() !== 0) {
      const r4 = await withTrace(() => readDirtyRootExempt(denied));
      assert(
        r4.value.entries.length === 0 &&
          r4.lines.length > 0 &&
          (r4.value.readFailed ?? "").includes("EACCES"),
        "an EACCES config is empty plus a trace, not a throw",
      );
    }
  }

  // ---- 6. two cycle contexts do not share exemptions ----------------------
  {
    // The list is a PARAMETER on every consumer. Two contexts carrying
    // different lists must answer differently from the same matcher, which is
    // what module-scope state could not guarantee with up to
    // PI_ENSEMBLE_PARALLEL_GROUPS cycles in one process.
    const a = [".claude"];
    const b: string[] = [];
    const line = "?? .claude/settings.local.json";
    assert(
      isConfiguredExemptDirtLine(line, a) === true && isConfiguredExemptDirtLine(line, b) === false,
      "two contexts with different lists decide differently for the same line — nothing is shared",
    );
    // Mutating one caller's array cannot change another's answer: the matcher
    // reads its argument, and never caches a decision across calls.
    const shared = [".claude"];
    const first = isConfiguredExemptDirtLine(line, shared);
    shared.push(".vscode");
    const second = isConfiguredExemptDirtLine(line, [".vscode"]);
    assert(
      first === true && second === false,
      "an earlier call's list is not remembered by a later one (no module-scope cache)",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
