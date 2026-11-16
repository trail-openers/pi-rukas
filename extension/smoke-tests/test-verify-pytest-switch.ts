#!/usr/bin/env bun
/**
 * #2282 — the `PI_ENSEMBLE_VERIFY_PYTEST` switch, and what each arm must never
 * do: report a judgement it did not make.
 *
 * The bug this arm closes is a silent green. A Python repo with `pyproject.toml`
 * and a pytest suite resolved to no verify command at all, so the develop gate
 * ran nothing and the develop prompt told the child to "rely on the change being
 * correct and complete". The switch's off arm restores that state deliberately —
 * which is exactly why the off arm is pinned here rather than trusted: an
 * operator turning the arm off must be able to predict that a Python repo then
 * runs no command, and an operator who merely mis-typed the disable must get the
 * arm.
 *
 * Four things are pinned:
 *
 *   - **the resolver's truth table** — `"0"` is the only off value; `false`,
 *     `off`, `no`, a padded ` 0 `, the empty string and the absent value all
 *     leave the arm on. A misspelled disable that read as off would be the most
 *     reliable way to pass the develop step.
 *   - **the off arm is byte-identical to the pre-#2282 shipped strings** — the
 *     resolved command, the develop prompt's command-bearing line, and the
 *     no-command note. The on arm is what differs, and the comparison is shown to
 *     be non-vacuous.
 *   - **the docs row and the inventory entry** say the same thing as the code
 *     does (`test-headless-inputs.ts` pins the roster against the readers but
 *     never opens `docs/`, so a wired-but-undocumented knob is otherwise invisible
 *     to this suite).
 *   - **a command that cannot judge the tree fails, with the executor's own
 *     words as the reason** — `python`-not-found (127), pytest not importable
 *     (exit 1), and pytest collecting nothing (exit 5) are each a gate failure,
 *     never a pass and never a skip. The third is a pinned property of the
 *     executor rather than new behaviour: `execp` resolves only on exit 0, so a
 *     collected-nothing run rejects by construction. Without these, the arm could
 *     close the silent-green hole by opening a wider one.
 *
 * The gate-level cases drive the real develop gate over real git, with the
 * project's command executed for real (`/bin/sh`, PATH stripped) — a canned
 * "not found" from a fake executor would prove only that the fake can throw.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { execp, verifyCmdFor, verifyStepOutcome } from "../src/work-driver-verify.ts";
import { developVerifyLine } from "../src/work-driver-verify-fast.ts";
import { noVerifyCmdNote } from "../src/work-driver-verify-develop-cmd.ts";
import {
  VERIFY_PYTEST_ENV,
  buildDriverKnobNames,
  verifyChildEnv,
  verifyPytestDisabled,
} from "../src/work-driver-verify-cmd.ts";
import {
  type Counts,
  ctxFor,
  makeExec,
  stateFor,
} from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";
import {
  PY_CMD,
  pythonRepo,
  withEnv,
  withEnvRun,
} from "./lib/verify-pytest-switch.ts";

let exit = 0;
const run = promisify(execFile);
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── the resolver's truth table ───────────────────────────────────────────────
{
  // One disable spelling, and the plausible ones that are NOT switches. These
  // are the values a develop child could put in the environment it controls, so
  // a parser wider than `=== "0"` is a gate the child can turn off.
  for (const raw of ["0"]) {
    assert(
      withEnvRun(VERIFY_PYTEST_ENV, raw, () => verifyPytestDisabled()) === true,
      `the one disable: PI_ENSEMBLE_VERIFY_PYTEST=${JSON.stringify(raw)} turns the Python arm off`,
    );
  }
  for (const raw of ["", "  ", "1", "false", "FALSE", "no", "off", "OFF", "maybe", "2", "00 ", " 0 "]) {
    assert(
      withEnvRun(VERIFY_PYTEST_ENV, raw, () => verifyPytestDisabled()) === false,
      `not a disable: ${JSON.stringify(raw)} leaves the arm on — a misspelled disable is never a deliberate one`,
    );
  }
  assert(
    verifyPytestDisabled() === false,
    "with the knob absent the arm is ON: a Python repo gets a discovered command by default",
  );
  assert(
    VERIFY_PYTEST_ENV === "PI_ENSEMBLE_VERIFY_PYTEST",
    "the switch name is the one docs/configuration.md, headless/inputs-b.ts and LIVE_INPUTS all name",
  );
}

// ── the knob is registered, listed, and documented ───────────────────────────
{
  const entry = HEADLESS_INPUTS.find((e) => e.name === VERIFY_PYTEST_ENV);
  assert(
    entry?.type === "boolean" && entry.default === true,
    `headless/inputs-b.ts lists ${VERIFY_PYTEST_ENV} as a boolean defaulting to true (got ${JSON.stringify(entry)})`,
  );
  // The verify env scrub builds its drop-list from this inventory, so an entry
  // missing here would leak the DRIVER's switch into the project's pytest run.
  assert(
    buildDriverKnobNames(HEADLESS_INPUTS).has(VERIFY_PYTEST_ENV),
    "the knob is in the scrub list: the project's own pytest never sees the driver's switch",
  );
  assert(
    Object.prototype.hasOwnProperty.call(verifyChildEnv({ [VERIFY_PYTEST_ENV]: "0" }), VERIFY_PYTEST_ENV) ===
      false,
    "verifyChildEnv drops it from a project command's environment",
  );

  const docs = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md"),
    "utf8",
  );
  // The row is matched by its leading table cell, not by the first line that
  // merely mentions the name: the coupling row of another knob cites it too, and
  // asserting against that row would pass on text that says none of what the
  // switch itself does.
  const row = docs
    .split("\n")
    .find((l) => l.startsWith(`| \`${VERIFY_PYTEST_ENV}\` |`));
  assert(row !== undefined, "docs/configuration.md carries a row for the switch");
  for (const [needle, why] of [
    ['`"0"`', "names the one off value, so an operator can spell the disable"],
    ["python3 -m pytest -q", "names the interpreter the command uses"],
    ["uv run pytest -q", "names the uv form a uv.lock repo gets"],
    ["never a bare `python`", "names the interpreter form that must never appear"],
    ["gate failure", "says a missing prerequisite fails rather than skipping"],
  ] as const) {
    assert(row?.includes(needle) === true, `the docs row says ${why} (looks for ${needle})`);
  }
  // The coupling sentence the #2282 gap gate asked for: what the derived skip
  // covers has to be what `verifyCmdFor` actually derives.
  const coupling = docs.split("\n").find((l) => l.includes("PI_ENSEMBLE_FRONTEND_ONLY_GLOBS"));
  assert(
    coupling?.includes("pyproject.toml") === true && coupling?.includes("`go.mod` derives no command") === true,
    "the PI_ENSEMBLE_FRONTEND_ONLY_GLOBS coupling row names pyproject.toml as derived and says go.mod is not",
  );
}

// ── the off arm is byte-identical to the pre-#2282 strings ───────────────────
{
  // The four strings the issue names. (a) the command `verifyCmdFor` returns,
  // (b) the develop prompt's command-bearing line, which inherits (a) by
  // interpolation, (c) the chain's no-command note, and (d) the no-command
  // prompt line, which is unchanged on BOTH arms. The literals below are the
  // shipped pre-#2282 bytes, transcribed, so a change to any of them on the off
  // arm fails here rather than in a cycle that relied on the arm being inert.
  const PRE_NO_CMD_NOTE =
    "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only";
  const PRE_NO_CMD_PROMPT =
    "This project has no discoverable verify command, so there is no project-level check to run before you report back — rely on the change being correct and complete.";

  const dir = pythonRepo({ ruff: true });
  const uvDir = pythonRepo({ uvLock: true });
  try {
    const on = await withEnv(VERIFY_PYTEST_ENV, undefined, async () => ({
      plain: await verifyCmdFor(dir),
      uv: await verifyCmdFor(uvDir),
    }));
    const off = await withEnv(VERIFY_PYTEST_ENV, "0", async () => ({
      plain: await verifyCmdFor(dir),
      uv: await verifyCmdFor(uvDir),
    }));

    assert(
      off.plain === undefined && off.uv === undefined,
      `off: a pyproject repo resolves to no command again (got ${JSON.stringify(off)})`,
    );
    assert(
      on.plain === "ruff check . && python3 -m pytest -q" && on.uv === "uv run pytest -q",
      `on: the arm produces the two interpreter forms (got ${JSON.stringify(on)})`,
    );
    assert(on.plain !== off.plain, "the comparison is not vacuous: the on arm really differs");

    // (b) the prompt line inherits the command by interpolation, so pinning the
    // whole line pins the two together — the #751 coupling rule in miniature.
    const onPrompt = developVerifyLine(on.plain);
    const offPrompt = developVerifyLine(off.plain);
    assert(
      onPrompt.includes("`ruff check . && python3 -m pytest -q`") &&
        !offPrompt.includes("pytest"),
      "on: the develop prompt names the discovered pytest command; off: it names none",
    );
    assert(
      offPrompt === developVerifyLine(undefined),
      "off: the prompt line is the no-command line the pre-#2282 repo produced, byte for byte",
    );

    // (c) the note's manifest list gains pyproject/pytest on the on arm ONLY.
    await withEnv(VERIFY_PYTEST_ENV, "0", async () => {
      assert(
        noVerifyCmdNote() === PRE_NO_CMD_NOTE,
        `off: the no-command note is the pre-#2282 string verbatim (got ${JSON.stringify(noVerifyCmdNote())})`,
      );
    });
    await withEnv(VERIFY_PYTEST_ENV, undefined, async () => {
      const note = noVerifyCmdNote();
      assert(
        note.startsWith("no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml, ") &&
          note.endsWith(") — diff evidence only") &&
          note.includes("pyproject.toml"),
        `on: the same note names pyproject.toml among the sources it looked at (got ${JSON.stringify(note)})`,
      );
      assert(
        note !== PRE_NO_CMD_NOTE,
        "and the on arm's note really differs from the off arm's — not the same string twice",
      );
    });

    // (d) unchanged on both arms: the sentence the child reads when there is no
    // command must not become an advertisement for an arm that is off.
    assert(
      developVerifyLine(undefined) === PRE_NO_CMD_PROMPT,
      "the no-command prompt arm is untouched on both sides of the switch",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(uvDir, { recursive: true, force: true });
  }
}

// ── a discovered command that cannot judge the tree FAILS, in its own words ──
{
  // Three shapes of "the gate ran something that judged nothing", each produced
  // by the real executor under `/bin/sh` with a PATH that lacks the tool. A
  // fake that threw a canned message would only prove the fake can throw, and a
  // harness whose every command fails is indistinguishable from a gate that
  // correctly reports three red runs — hence the green control at the end.
    { // The interpreter form the issue forbids, run under a PATH without it.
      // Measured here rather than faked: `python` is genuinely absent on this
      // host, which is the whole reason the discovered string is `python3 -m
      // pytest -q` and not the `python -m pytest -q` the spec first drafted.
      const cwd = pythonRepo();
      let rejected = false;
      let text = "";
      let code: unknown;
      try {
        await execp("python -m pytest -q", { cwd, env: { PATH: "/usr/bin:/bin" } });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: unknown };
        rejected = true;
        code = e.code;
        text = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      }
      assert(
        rejected && code === 127 && text.includes("not found"),
        `python-missing: 127 with the executor's own "not found" — ${text.trim().slice(0, 60)}`,
      );
    }
    { // A runner the environment cannot import, spelled the way a real invocation
      // is spelled (`python3 -m <runner>`). The point is the SHAPE of the failure:
      // a command that dies before it judges anything still carries its own
      // reason, and the gate forwards it. `pytest` is installed on this host,
      // `pytestx` is not, and the distinction the assertion makes is the one the
      // gate must make — not a canned string from a fake.
      const cwd = pythonRepo();
      let rejected = false;
      let text = "";
      let code: unknown;
      try {
        await execp("python3 -m pytestx -q", { cwd, env: { PATH: "/usr/bin:/bin" } });
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: unknown };
        rejected = true;
        code = e.code;
        text = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      }
      assert(
        rejected && code === 1 && text.includes("No module named"),
        `runner-not-installed: rejected carrying "No module named" (code ${String(code)}) — ${text.trim().slice(0, 60)}`,
      );
    }
    { // Exit 5 — pytest ran and collected nothing. This is a pinned PROPERTY of
      // the executor, not behaviour this PR builds: `execp` resolves only on exit
      // 0, so every other pytest status rejects by construction. Pinning it here
      // is what stops a later "convenience" that treats 5 as a pass.
      // A manifest with no `testpaths` and no test file: the run gets as far as
      // "no tests ran" and reports nothing judged.
      const dir = mkdtempSync(path.join(tmpdir(), "verify-pytest-empty-"));
      writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
      let resolved = false;
      let code: unknown;
      let out = "";
      try {
        await execp("python3 -m pytest -q", { cwd: dir, env: { PATH: "/usr/bin:/bin" } });
        resolved = true;
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; code?: unknown };
        code = e.code;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      assert(
        !resolved && code === 5 && out.includes("no tests ran"),
        `collected-nothing: exit 5 with "no tests ran" is a rejection, never a pass (resolved=${String(resolved)}, code=${String(code)}, out=${JSON.stringify(out.trim())})`,
      );
      rmSync(dir, { recursive: true, force: true });
    }
    { // The green the whole arm exists to produce: a real pytest suite in a real
      // repo passes through the same executor the gate uses. Without this the
      // three failures above could be the signature of a broken harness rather
      // than of three genuinely-red runs.
      const cwd = pythonRepo();
      let ok = false;
      try {
        await execp("python3 -m pytest -q", { cwd, env: { PATH: "/usr/bin:/bin" } });
        ok = true;
      } catch {
        ok = false;
      }
      assert(ok, "control: a discoverable command that DOES pass resolves through execp");
    }
  }

// ── the develop gate: on runs the discovered command, off runs nothing ───────
{
  // Real git, a real worktree, and the project's command counted in the
  // executor — so "the arm is off" means the observable fact that NO command
  // ran and the note says the discovery found nothing.
  const root = mkdtempSync(path.join(tmpdir(), "verify-pytest-gate-"));
  try {
    // The project's own command is answered by the executor — counted, and given
    // the verdict the case asks for. Everything else the drive runs (the baseline
    // probe's checkouts, the consolidation, every git read) runs for real, so the
    // only thing a case decides is the discovered command's verdict. Answering
    // git from a table instead would let a drive that never reached the verify leg
    // still look like one that ran it.
    // `makeExec` already runs every git read for real under an isolated git view;
    // this executor only intercepts the project's own command, so the counts are
    // the whole evidence for "the arm ran / did not run" and nothing else in the
    // drive is canned.
    const drive = async (
      name: string,
      issue: number,
      seed: Record<string, string>,
      opts: { fail?: boolean; cmd?: string; changedFile?: string } = {},
    ) => {
      const f = await fixture(root, name, ["default"], seed);
      const wt = f.worktrees.default as string;
      const changed = opts.changedFile ?? "app.py";
      writeFileSync(path.join(wt, changed), "x = 1\n");
      await run("git", ["add", "."], { cwd: wt });
      await run("git", ["commit", "-q", "-m", "task: add app"], { cwd: wt });
      // The change is left in the working tree as well as committed, because the
      // touched-path union the gate classifies on comes from `git status
      // --porcelain` (plus the diff against this workstream's base, which the
      // fixture's worktree already carries). A committed-only change is invisible
      // to porcelain, and an empty union never skips — the classification would
      // fall back to the chain for a reason that has nothing to do with the arm.
      writeFileSync(path.join(wt, changed), "x = 2\n");
      const counts: Counts = { runs: [], repoRoot: f.repo };
      const base = makeExec(counts, opts);
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
        if (cmd === (opts.cmd ?? PY_CMD)) {
          counts.runs.push({ cwd: o?.cwd ?? "?" });
          if (opts.fail) {
            throw Object.assign(new Error(`Command failed: ${cmd}`), {
              code: 1,
              stdout: "",
              stderr: "FAILED tests/test_ok.py::test_ok\n1 failed in 0.01s\n",
            });
          }
          return { stdout: "1 passed in 0.01s\n" };
        }
        return base(cmd, o);
      };
      const ctx = ctxFor(f.repo, issue, exec) as Parameters<typeof verifyStepOutcome>[0];
      const gate = await verifyStepOutcome(ctx, stateFor(f, issue), "develop");
      return { f, gate, counts };
    };

    const pySeed = {
      "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      "tests/test_ok.py": "def test_ok():\n    assert True\n",
    };

    {
      // The green the whole arm exists to produce: a Python repo whose change is
      // a source file now gets a recorded run of the discovered command, and no
      // "diff evidence only" note. The verdict is the gate's own field, not a
      // string in a note.
      const { gate, counts } = await withEnv(VERIFY_PYTEST_ENV, undefined, () =>
        drive("on", 2282, pySeed),
      );
      assert(
        counts.runs.length > 0,
        `on: the develop gate ran the discovered command (runs: ${JSON.stringify(counts.runs)})`,
      );
      assert(
        gate.verifyRun?.status === "ran" && gate.verifyRun.command === PY_CMD,
        `on: the recorded run says it ran the discovered command (got ${JSON.stringify(gate.verifyRun)})`,
      );
      assert(
        gate.ok === true,
        `on: the develop gate is GREEN for a passing pytest suite (failures: ${JSON.stringify(gate.failures.slice(0, 2))})`,
      );
      assert(
        !gate.notes.some((n) => n.startsWith("no verify command discoverable")),
        "on: the no-command note is absent — the field case's symptom is gone",
      );
    }

    {
      // A red suite must not read as a pass. The discovered command is the one
      // place the arm could quietly convert a failure into nothing.
      const { gate, counts } = await withEnv(VERIFY_PYTEST_ENV, undefined, () =>
        drive("red", 2287, pySeed, { fail: true }),
      );
      assert(counts.runs.length > 0, "red: the discovered command ran");
      assert(
        gate.ok === false &&
          gate.failures.some((f) => f.includes("python3 -m pytest -q") && f.includes("FAILED")),
        `red: the gate failed carrying the suite's own line (ok=${String(gate.ok)}, failures=${JSON.stringify(gate.failures.slice(0, 1))})`,
      );
    }

    {
      // A change with nothing to verify still reaches the chain: the gate's
      // classification is a separate concern, exercised in the block above.
      const { gate } = await withEnv(VERIFY_PYTEST_ENV, undefined, () =>
        drive("css", 2285, pySeed, { changedFile: "styles.css" }),
      );
      assert(
        gate.verifyRun?.status === "ran" && gate.verifyRun.command === PY_CMD,
        `a CSS change in a Python repo runs the discovered command rather than guessing (got ${JSON.stringify(gate.verifyRun)})`,
      );
    }

    {
      const { gate, counts } = await withEnv(VERIFY_PYTEST_ENV, "0", () =>
        drive("off", 2283, pySeed),
      );
      assert(
        counts.runs.length === 0,
        `off: the develop gate ran no project command (runs: ${JSON.stringify(counts.runs)})`,
      );
      assert(
        gate.notes.some(
          (n) =>
            n ===
            "no verify command discoverable (.pi/verify-cmd, package.json scripts, Cargo.toml) — diff evidence only",
        ),
        `off: the note is the pre-#2282 string verbatim (got ${JSON.stringify(gate.notes.filter((n) => n.includes("no verify command")))})`,
      );
      assert(
        gate.verifyRun?.status === "not-run",
        // The record starts as `not-run` and is only replaced by an executed
        // command, so the assertion is about the record's own field: nothing here
        // can claim a command passed. (`undefined` is not the shape the gate
        // returns — it always carries the slot.)
        `off: the gate recorded no executed verify run (got ${JSON.stringify(gate.verifyRun)})`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
