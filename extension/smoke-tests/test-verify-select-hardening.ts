#!/usr/bin/env bun
/**
 * #1647 review round 3 — the selected verify's hardening, one assertion per finding:
 *
 *   - the selector resolves extensionless and directory imports, falls back on an
 *     unresolved specifier, selects every test that reaches a dynamic-import module,
 *     never selects a live test, refuses an unsafe name, and reads regex literals
 *     (a quote inside one hides nothing);
 *   - the attribution compares failure signatures before it excuses a baseline-red
 *     test, shares one wall clock across its runs and probes, reruns named failures
 *     by ID, and blocks on a name it cannot place;
 *   - the PR body's attribution block is replaced, not appended to: a repeated
 *     write converges, a null body is written, and a body the writer cannot read
 *     as text (or cannot read at all) is never edited.
 *
 * The attribution stub is the one the exec suite uses: verify-loop's out-of-band
 * report and its `FAILED:` stream, with real git for the base probe.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { discloseInPrBody } from "../src/work-driver-ci-verify.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { createVerifyChannel } from "../src/work-driver-integrate-verify-flake.ts";
import { ALWAYS_RUN } from "../src/work-driver-verify-always-run.ts";
import { foldVerifyAttribution } from "../src/work-driver-verify-events.ts";
import {
  type SelectedVerifyRecord,
  withSelectedAttribution,
} from "../src/work-driver-verify-select-exec.ts";
import { ATTRIBUTION_BEGIN } from "../src/work-driver-verify-select-render.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  edgesOf,
  selectVerifyTests,
  selectedVerifyCommand,
} from "../src/work-driver-verify-select.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const extensionDir = path.resolve(import.meta.dirname, "..");

// --- the selector: a fixture tree --------------------------------------------
const root = mkdtempSync(path.join(tmpdir(), "pi-verify-select-hardening-"));
const ext = path.join(root, "extension");
const write = (rel: string, text: string) => {
  const file = path.join(ext, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};
write("src/a.ts", "export const a = 1;\n");
write("src/leaf.ts", "export const leaf = 2;\n");
write("src/unrelated.ts", "export const u = 3;\n");
write("src/headless/index.ts", "export const h = 4;\n");
write("src/loader.ts", "export async function load(spec: string) {\n  return import(spec);\n}\n");
write("src/broken.ts", 'import { missing } from "./nowhere";\nexport const b = missing;\n');
write("src/livemod.ts", "export const lm = 5;\n");
write("smoke-tests/test-dir.ts", 'import { h } from "../src/headless";\nvoid h;\n');
write("smoke-tests/test-ext.ts", 'import { leaf } from "../src/leaf";\nvoid leaf;\n');
write("src/c.ts", "export const c = 6;\n");
write("smoke-tests/test-js.ts", 'import { c } from "../src/c.js";\nvoid c;\n');
write("smoke-tests/test-u.ts", 'import { u } from "../src/unrelated.ts";\nvoid u;\n');
write("smoke-tests/test-loader-user.ts", 'import "../src/loader.ts";\n');
write("smoke-tests/test-broken.ts", 'import { b } from "../src/broken.ts";\nvoid b;\n');
write("smoke-tests/test-live-one-live.ts", 'import { lm } from "../src/livemod.ts";\nvoid lm;\n');
write("smoke-tests/test-a b.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');
write("smoke-tests/test-plain.ts", 'import { a } from "../src/a.ts";\nvoid a;\n');

const sel = (changed: string[]) => selectVerifyTests(ext, changed);

// Extensionless and directory imports resolve like the bundler the repo's tests run under.
assert(
  sel(["src/headless/index.ts"]).tests.includes("smoke-tests/test-dir.ts"),
  "a directory import (`../src/headless`) resolves to its index.ts",
);
assert(
  sel(["src/leaf.ts"]).tests.includes("smoke-tests/test-ext.ts"),
  "an extensionless import (`../src/leaf`) resolves to the .ts module",
);
assert(
  sel(["src/c.ts"]).tests.includes("smoke-tests/test-js.ts"),
  "a `.js` specifier resolves to the `.ts` module it names",
);

// An unresolved relative specifier on the walk path cannot be trusted.
const broken = sel(["src/broken.ts"]);
assert(
  broken.mode === "full" && broken.fallbackReason === "unresolved-specifier:src/broken.ts",
  "a relative specifier that names no graph node falls back to the full suite",
);

// A test that reaches a non-literal dynamic import runs on every selection.
const unrelated = sel(["src/unrelated.ts"]);
assert(
  unrelated.mode === "selected" && unrelated.tests.includes("smoke-tests/test-loader-user.ts"),
  "a test that imports a non-literal dynamic-import module is selected for an unrelated change",
);

// A name that cannot go into a shell argument falls back, whatever the graph says.
const unsafe = sel(["src/a.ts"]);
assert(
  unsafe.mode === "full" && unsafe.fallbackReason === "unsafe-test-name",
  "a selected test name with a space falls back with unsafe-test-name",
);

// Live tests never run offline: they are not selected and not in the list.
const live = sel(["src/livemod.ts"]);
assert(
  live.mode === "full" && live.fallbackReason === "no-selected-tests:src/livemod.ts",
  "a module reached only by a live test selects no offline test (full suite, reason named)",
);
assert(!ALWAYS_RUN.some((t) => /-live\.ts$/.test(t)), "no -live.ts test is in ALWAYS_RUN");
const unrelatedLive = sel(["src/unrelated.ts"]);
assert(
  unrelatedLive.tests.every((t) => !/-live\.ts$/.test(t)),
  "a selection never carries a -live.ts test",
);
const ci = await Bun.file(path.join(extensionDir, "..", ".pi", "verify-cmd-full")).text();
assert(
  ci.includes("grep -v -- '-live[.]ts$'"),
  ".pi/verify-cmd-full drops -live.ts tests from the suite it runs",
);

// verify-loop never runs a -live.ts test, even when it is named explicitly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-verify-live-"));
  const marker = path.join(dir, "ran");
  const liveFile = path.join(dir, "test-probe-live.ts");
  writeFileSync(liveFile, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  let status: number | undefined;
  try {
    execFileSync("bash", [path.join(extensionDir, "smoke-tests/lib/verify-loop.sh"), liveFile], {
      cwd: extensionDir,
      stdio: "pipe",
    });
    status = 0;
  } catch (err) {
    status = (err as { status?: number }).status;
  }
  assert(
    status === 3 && !existsSync(marker),
    "verify-loop given a -live.ts file runs nothing (exit 3, the marker is not written)",
  );
  rmSync(dir, { recursive: true, force: true });
}
rmSync(root, { recursive: true, force: true });

// --- the tokenizer -------------------------------------------------------------
const quoteInRegex = edgesOf(
  "smoke-tests/t.ts",
  'const re = /"/;\nimport { a } from "../src/a.ts";\nvoid [a, re];\n',
);
assert(
  quoteInRegex?.specifiers.includes("../src/a.ts") === true,
  "a quote inside a regex literal does not hide the import after it",
);
const slashStar = edgesOf(
  "smoke-tests/t.ts",
  'const re = /\\/*x/;\nimport { a } from "../src/a.ts";\nvoid [a, re];\n',
);
assert(
  slashStar?.specifiers.includes("../src/a.ts") === true,
  "a regex that spells `/*` does not open a comment that hides the import",
);
assert(
  edgesOf("smoke-tests/t.ts", 'const s = "unterminated;\n') === undefined,
  "a file the tokenizer cannot close is unreadable, not an empty graph node",
);
assert(
  edgesOf("src/x.ts", "const q = a / b / c;\nawait import(spec);\n")?.dynamic === true,
  "division is not a regex: the dynamic import after it is still seen",
);

// --- the attribution: a stub with real git for the base probe ------------------
const attrRoot = mkdtempSync(path.join(tmpdir(), "pi-verify-select-attr-"));
const repo = path.join(attrRoot, "repo");
mkdirSync(path.join(repo, "extension", "smoke-tests"), { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
mkdirSync(path.join(repo, ".pi"), { recursive: true });
writeFileSync(path.join(repo, ".pi", "verify-select"), "");
writeFileSync(path.join(repo, "extension", "smoke-tests", "placeholder.txt"), "x\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "base"]);
const baseSha = git(["rev-parse", "HEAD"]).trim();

const T = "smoke-tests/test-x.ts";

interface Stub {
  /** Tests that fail on this change, and how many times each fails before it passes. */
  change: Record<string, number>;
  /** Tests that fail on base. */
  base: string[];
  /** The failure line each tree prints for a failing test. */
  reason: { change: string; base: string };
  /** Milliseconds the first change run takes before it fails. */
  delayMs?: number;
  /** Names the first change run reports, instead of the real ones. */
  rawNames?: string[];
}

/** Every command the stub saw, for the rerun-shape assertions. */
function stub(s: Stub, seen: string[]) {
  const remaining = { ...s.change };
  let changeRuns = 0;
  return async (cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv; argv?: string[] }) => {
    if (opts?.argv !== undefined) {
      const { stdout, stderr } = await execFileP(cmd, opts.argv, { cwd: opts.cwd });
      return { stdout, stderr };
    }
    if (!cmd.includes("verify-loop.sh")) {
      const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], { cwd: opts?.cwd });
      return { stdout, stderr };
    }
    seen.push(cmd);
    const isProbe = opts?.cwd !== repo;
    const tree = opts?.cwd ?? repo;
    const requested = [...cmd.matchAll(/"\$PWD\/([^"]+)"/g)].map((m) => m[1] ?? "");
    if (!isProbe) changeRuns++;
    if (!isProbe && changeRuns === 1 && s.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, s.delayMs));
    }
    const failing = isProbe
      ? requested.filter((r) => s.base.includes(r))
      : requested.filter((r) => {
          const left = remaining[r] ?? 0;
          if (left > 0) {
            remaining[r] = left - 1;
            return true;
          }
          return false;
        });
    if (failing.length === 0) return { stdout: "all green\n", stderr: "" };
    const names =
      !isProbe && changeRuns === 1 && s.rawNames !== undefined
        ? s.rawNames
        : failing.map((r) => path.join(tree, "extension", r));
    const reportFile = opts?.env?.VERIFY_REPORT_FILE;
    if (reportFile)
      writeFileSync(reportFile, `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`, "utf8");
    const reason = isProbe ? s.reason.base : s.reason.change;
    const stream = [
      ...names.map((n) => `FAILED: ${n}\n✗ case one\n  ${reason}`),
      `FAILED: ${names.length} test(s) — ${names.join(", ")}`,
    ].join("\n");
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: stream, stderr: "" });
  };
}

async function attempt(
  name: string,
  s: Stub,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; record: SelectedVerifyRecord; seen: string[]; stderr: string }> {
  const channel = createVerifyChannel();
  if (channel === undefined) throw new Error(`${name}: no report channel`);
  const record: SelectedVerifyRecord = { flaky: [], baselineRed: [] };
  const seen: string[] = [];
  const cmd = selectedVerifyCommand([T]);
  const exec = stub(s, seen);
  const wrapped = withSelectedAttribution(exec, exec, {
    cmd,
    channel,
    repoRoot: repo,
    baseSha,
    changeRoots: [repo],
    changedTests: [],
    probeLabel: `hardening-${name}`,
    timeoutMs,
    record,
  });
  let ok = true;
  let stderr = "";
  try {
    await wrapped(cmd, { cwd: repo });
  } catch (err) {
    ok = false;
    stderr = `${(err as Error).message}\n${(err as { stderr?: string }).stderr ?? ""}`;
  } finally {
    rmSync(channel.reportDir, { recursive: true, force: true });
  }
  return { ok, record, seen, stderr };
}

// The same failure line on base and on the change: the test is baseline-red.
{
  const r = await attempt("same-reason", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "expected 3 got 4", base: "expected 3 got 4" },
  });
  assert(r.ok && r.record.baselineRed.join() === T, "the same failure line on base → baseline-red");
}
// A different failure line on base: red on base for another reason, so it blocks.
{
  const r = await attempt("other-reason", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "expected 3 got 4", base: "timed out waiting for the socket" },
  });
  assert(
    !r.ok && r.record.baselineRed.length === 0 && r.stderr.includes("different reason"),
    "a test red on base for a different failure line blocks",
  );
}
// Digits are folded out, so a timing figure alone does not make two failures differ.
{
  const r = await attempt("timing-only", {
    change: { [T]: 2 },
    base: [T],
    reason: { change: "took 812 ms, budget 500", base: "took 640 ms, budget 500" },
  });
  assert(
    r.ok && r.record.baselineRed.join() === T,
    "a failure that differs only in digits is the same failure",
  );
}
// The rerun of a named failure runs its IDs through the probe's shape, not the whole suite.
{
  const r = await attempt("rerun-ids", {
    change: { [T]: 1 },
    base: [],
    reason: { change: "x", base: "x" },
  });
  const rerun = r.seen[1] ?? "";
  assert(
    r.ok &&
      r.record.flaky.join() === T &&
      !rerun.includes("tsc --noEmit") &&
      rerun.includes(`"$PWD/${T}"`),
    "a named failure is rerun by its IDs, not the whole command",
  );
}
// A failing name that is not a smoke-test path cannot be rerun by ID: blocks.
{
  const r = await attempt("unplaceable", {
    change: { [T]: 1 },
    base: [],
    reason: { change: "x", base: "x" },
    rawNames: ["/tmp/elsewhere/notes.ts"],
  });
  assert(
    !r.ok && r.stderr.includes("cannot be rerun by its ID"),
    "a failing name that cannot be placed blocks, with the reason named",
  );
}
// One wall clock: a first run that uses it all leaves the rerun no budget, and the block names the step.
{
  const r = await attempt(
    "deadline",
    { change: { [T]: 1 }, base: [], reason: { change: "x", base: "x" }, delayMs: 120 },
    60,
  );
  assert(
    !r.ok && r.stderr.includes("wall clock ran out before the rerun") && r.seen.length === 1,
    "the first run and the rerun share one wall clock; exhausting it blocks, naming the step",
  );
}

// --- disclosure: one replaceable block, written only from a readable PR body ----
{
  const T2 = "smoke-tests/test-flaky-a.ts";
  const T3 = "smoke-tests/test-flaky-b.ts";
  const state = foldVerifyAttribution(
    { ...initialState(9), pipelineState: { ...initialState(9).pipelineState, prNumber: 77 } },
    { flaky: [T2], baselineRed: [] },
  );
  // discloseInPrBody reads only the repo root and the issue number.
  const ctx = { repoRoot: root, issue: 9 } as unknown as CycleContext;
  const ghWith = (view: () => string, edits: string[]): ExecFn =>
    (async (cmd: string, opts?: { argv?: string[] }) => {
      const argv = opts?.argv ?? [];
      if (cmd !== "gh") throw new Error(`unexpected command ${cmd}`);
      if (argv[1] === "view") return { stdout: view(), stderr: "" };
      if (argv[1] === "edit") {
        edits.push(readFileSync(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8"));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh ${argv.join(" ")}`);
    }) as unknown as ExecFn;
  const bodyOf = (body: string | null) => JSON.stringify({ body });

  // First write: the intro is kept and the block is appended once.
  const edits1: string[] = [];
  const first = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf("Intro text"), edits1),
  );
  assert(first.ok && edits1.length === 1, "a readable body with no block is written once");
  const written1 = edits1[0] ?? "";
  assert(
    written1.startsWith("Intro text") &&
      written1.split(ATTRIBUTION_BEGIN).length === 2 &&
      written1.includes(T2),
    "the written body keeps the intro and carries exactly one attribution block naming the flaky test",
  );
  // A repeated write of the same record is a no-op: the block converges.
  const edits2: string[] = [];
  const again = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(written1), edits2),
  );
  assert(again.ok && edits2.length === 0, "writing the same record again changes nothing");
  // A grown record replaces the block rather than appending a second one.
  const grown = foldVerifyAttribution(state, { flaky: [T3], baselineRed: [] });
  const edits3: string[] = [];
  await discloseInPrBody(
    ctx,
    grown,
    ghWith(() => bodyOf(written1), edits3),
  );
  const written3 = edits3[0] ?? "";
  assert(
    written3.split(ATTRIBUTION_BEGIN).length === 2 &&
      written3.includes(T3) &&
      written3.includes(T2),
    "a later write replaces the block with the whole record, not a second block",
  );
  // A null body is an empty PR body, so it is written rather than refused.
  const edits4: string[] = [];
  const nullBody = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(null), edits4),
  );
  assert(nullBody.ok && edits4.length === 1, "a null PR body is treated as empty and written");
  // A body that is not text is refused, and nothing is edited.
  const edits5: string[] = [];
  const notText = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(7 as never), edits5),
  );
  assert(
    !notText.ok && edits5.length === 0 && notText.reason.includes("could not be read as text"),
    "a PR body that is not a string is refused with the reason named, and never edited",
  );
  // A failed read is named and nothing is edited.
  const edits6: string[] = [];
  const unread = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => {
      throw new Error("gh: network down");
    }, edits6),
  );
  assert(
    !unread.ok && edits6.length === 0 && unread.reason.includes("network down"),
    "a PR body read that throws is named and the body is left alone",
  );
  // Half-marked markers are a body the writer does not understand: refused, not patched.
  const edits7: string[] = [];
  const halfMarked = await discloseInPrBody(
    ctx,
    state,
    ghWith(() => bodyOf(`x\n${ATTRIBUTION_BEGIN}\nno end`), edits7),
  );
  assert(!halfMarked.ok && edits7.length === 0, "unpaired attribution markers are refused");

  // #1788 — the disclosure write is a PUBLIC publish the tool_call guard cannot
  // see (an in-process exec), so the same matcher judges the body before the
  // file is written. A dirty body is refused and `gh pr edit` never runs; a
  // clean one still writes, so the block is not satisfied by a gate that refuses
  // everything. Synthetic term; this repository is public.
  const dirtyTerm = "example-private-host";
  const dirtyList = path.join(root, "denylist");
  writeFileSync(dirtyList, `# synthetic\n${dirtyTerm}\n`, "utf8");
  const prevDenylist = process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
  process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = dirtyList;
  try {
    // The record must be non-empty, or the write is a no-op (`next === current`)
    // and the check under test is never reached at all.
    const recordState = foldVerifyAttribution(state, { flaky: [T2], baselineRed: [] });
    const dirtyBody = `Intro mentioning ${dirtyTerm} and nothing else`;
    const edits8: string[] = [];
    const execSpy = ghWith(() => bodyOf(dirtyBody), edits8);
    let seenCmd = "";
    const spying: ExecFn = (async (cmd: string, opts?: { argv?: string[] }) => {
      if (cmd === "git") seenCmd = (opts?.argv ?? []).join(" ");
      return execSpy(cmd, opts);
    }) as unknown as ExecFn;
    const dirty = await discloseInPrBody(ctx, recordState, spying);
    assert(
      !dirty.ok &&
        edits8.length === 0 &&
        /private/.test(dirty.reason) &&
        seenCmd.startsWith("remote get-url"),
      `a dirty disclosure body is refused before the PR is edited, and nothing is written (reason ${dirty.ok ? "ok" : dirty.reason.slice(0, 40)}, git saw ${seenCmd || "nothing"})`,
    );
    // The same command with a clean body writes, so the check above is a filter
    // and not a wall.
    const edits9: string[] = [];
    const clean = await discloseInPrBody(ctx, recordState, ghWith(() => bodyOf("Intro about the public build"), edits9));
    assert(
      clean.ok && edits9.length === 1,
      "a clean disclosure body still reaches gh pr edit — the check refuses nothing it should not",
    );
  } finally {
    if (prevDenylist === undefined) delete process.env.PI_ENSEMBLE_PUBLIC_DENYLIST;
    else process.env.PI_ENSEMBLE_PUBLIC_DENYLIST = prevDenylist;
  }
}
rmSync(attrRoot, { recursive: true, force: true });

// The always-run list is generated and the gate that uses it never names a -live test.
assert(ALWAYS_RUN.length > 0, "ALWAYS_RUN is populated");

process.exit(exit);
