#!/usr/bin/env bun
/**
 * #1642 — the driver's knobs never reach a project gate, on EVERY path that
 * runs one.
 *
 * #1687 scrubbed the DEVELOP verify (`verifyChildEnv` in the shell executor)
 * and measured that a headless runner's `PI_ENSEMBLE_HANDOFF_CHANNEL=host`
 * flips ~22 unrelated smoke tests. That scrub sits in `shellExecp`, so it
 * covers only a command executed through THAT executor. The commit-pr /
 * integration and ci tiers build their own child env (`{ ...process.env }` for
 * the #1404 report channel, `opts?.env ?? process.env` in the attribution
 * wrapper) or pass no env at all and inherit the parent wholesale — and every
 * one of those reaches the project's command through an injected or raw
 * executor that never consults the helper.
 *
 * Part 1 is behavioural and drives the real seams with a REAL child: the
 * commit-pr consolidated verify, the ci verify-full tier, the per-worktree
 * tier, the consolidated develop probe, the flake re-run, and the baseline
 * probe. Each is handed a driver knob set on `process.env` plus a knob the
 * verify loop owns, and asserts what the child actually saw.
 * Part 2 is the source canary: the sites must keep routing through the helper,
 * and must not re-inherit the parent env for a project command.
 */

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import {
  VERIFY_HOST_ENV_KEEP,
  verifyChildEnv,
  verifyHostEnv,
} from "../src/work-driver-verify-cmd.ts";
import { runVerifyFull } from "../src/work-driver-verify-full.ts";
import { execp as verifyExecp } from "../src/work-driver-verify.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

const LEAK = VERIFY_HOST_ENV_KEEP;
const LOOP = "PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S";
const KEEP = "VERIFY_ENV_PROBE_KEEP_1642";
// The three probe variables are set for the whole file and RESTORED on every
// exit path. A module-level `process.env` write that no `finally` restores
// leaks the driver's own knob into every later test in the same process.
const saved: Record<string, string | undefined> = {
  [LEAK]: process.env[LEAK],
  [LOOP]: process.env[LOOP],
  [KEEP]: process.env[KEEP],
};
const restoreProbeEnv = () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
process.env[LEAK] = "host";
process.env[LOOP] = "900";
process.env[KEEP] = "kept";

/** What a real shell child reports for the three probe variables. */
const probeOf = (v: string) => `echo "[$${LEAK}][$${LOOP}][$${KEEP}]" # ${v}`;
const clean = (s: string) => s.replace(/\s*#.*$/, "").trim();

const scratch = mkdtempSync(path.join(tmpdir(), "verify-env-1642-"));

// The body runs as one async function so the restore sits in a `finally` that
// a throw inside any block still reaches.
await main().finally(restoreProbeEnv);
rmSync(scratch, { recursive: true, force: true });

console.log(
  failures === 0
    ? "\nAll #1642 project-gate child-env checks passed"
    : `\n${failures} #1642 project-gate child-env check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  console.log("1. commit-pr / integration verify: the child does not see the knob");
  {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const exec = async (cmd: string, o?: { env?: NodeJS.ProcessEnv }) => {
      seen.push(o?.env);
      return { stdout: "" };
    };
    const r = await runCommitPrConsolidatedVerify(exec, {
      verifyCmd: "the-project-verify",
      repoRoot: scratch,
      workstreamCount: 1,
      workstreamIds: ["default"],
      perWorktreeFailuresByWs: {},
      timeoutMs: 60_000,
    });
    assert(r.ok === true, "commit-pr verify: a passing run reports ok");
    assert(seen.length > 0, "commit-pr verify: the gate executed the project command");
    assert(
      seen.every((e) => e !== undefined && !(LEAK in e)),
      `commit-pr verify: EVERY env handed to the project command drops ${LEAK} (got ${JSON.stringify(
        seen.map((e) => (e ? Object.keys(e).filter((k) => k.startsWith("PI_ENSEMBLE_")) : "none")),
      )})`,
    );
    assert(
      seen.every((e) => e !== undefined && e[LOOP] === "900"),
      "commit-pr verify: the verify loop's own knob still reaches the child",
    );
    assert(
      seen.every((e) => e !== undefined && e[KEEP] === "kept"),
      "commit-pr verify: a non-driver variable is kept",
    );
    assert(
      seen.every((e) => e !== undefined && e.PATH !== undefined),
      "commit-pr verify: PATH survives the scrub",
    );
    // The #1404 report channel is the whole point of building the env by hand:
    // the scrub must not cost it.
    assert(
      seen.some((e) => e?.VERIFY_REPORT_FILE !== undefined),
      "commit-pr verify: VERIFY_REPORT_FILE still reaches the child through the scrubbed env",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("2. commit-pr flake re-run: the second run is scrubbed too");
  {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    let n = 0;
    const exec = async (cmd: string, o?: { env?: NodeJS.ProcessEnv }) => {
      if (cmd === "the-project-verify") {
        seen.push(o?.env);
        n += 1;
        // Fail both runs so the re-run path is exercised and classified.
        throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "✗ asserted" });
      }
      return { stdout: "" };
    };
    const r = await runCommitPrConsolidatedVerify(exec, {
      verifyCmd: "the-project-verify",
      repoRoot: scratch,
      workstreamCount: 2,
      workstreamIds: ["a", "b"],
      perWorktreeFailuresByWs: {},
      timeoutMs: 60_000,
    });
    assert(r.ok === false, "flake re-run: two red runs park");
    assert(n === 2, `flake re-run: the command ran twice (got ${n})`);
    assert(
      seen.length === 2 && seen.every((e) => e !== undefined && !(LEAK in e)),
      "flake re-run: BOTH runs carry a scrubbed env (the re-run is not the leak)",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("3. ci verify-full: a REAL child through the real shell executor");
  {
    // The ci tier's executor is `shellExecp`-shaped. Driving it with the real
    // executor is the only way to see what the process actually received.
    const r = await runVerifyFull(probeOf("ci-full"), scratch, 30_000, (cmd, o) =>
      verifyExecp(cmd, { ...o, killGroup: true }),
    );
    assert(r.outcome === "success", `ci verify-full: the probe command passed (${r.output})`);
    assert(
      clean(r.output) === "[][900][kept]",
      `ci verify-full: driver knob scrubbed, loop knob kept in the real child (got ${clean(r.output)})`,
    );
  }

  console.log("4. ci verify-full through a raw parent-inheriting executor");
  {
    // The shape the ci step had: an executor that ignores `env` and inherits the
    // parent. The tier must hand it a scrubbed env regardless.
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const r = await runVerifyFull("true", scratch, 30_000, async (_cmd, o) => {
      seen.push(o?.env);
      return { stdout: "" };
    });
    assert(r.outcome === "success", "ci verify-full: passing run reports success");
    assert(
      seen.length > 0 && seen.every((e) => e !== undefined && !(LEAK in e) && e[LOOP] === "900"),
      "ci verify-full: the tier itself hands the executor a scrubbed env, so an executor that inherits the parent cannot leak the knob",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("5. a long suite is not killed by the output bound");
  {
    // The gate writes well past the old 1 MiB cap and must still report the
    // suite's own verdict, not `maxBuffer length exceeded`.
    const cmd = `node -e 'process.stdout.write("x".repeat(1536*1024))'`;
    const r = await runVerifyFull(cmd, scratch, 60_000, (c, o) =>
      verifyExecp(c, { ...o, killGroup: true }),
    );
    assert(
      r.outcome === "success",
      `verify-full: 1.5 MiB of stdout passes the tier (${r.output.slice(0, 60)})`,
    );
    assert(!r.output.includes("maxBuffer"), "verify-full: no maxBuffer abort on a chatty suite");
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("6. the host-env helper keeps exactly one named driver knob");
  {
    const scrubbed = verifyChildEnv({ [LEAK]: "host", PATH: "/bin", OTHER: "1" });
    assert(!(LEAK in scrubbed), "verifyChildEnv: the knob is dropped, unconditionally");
    const host = verifyHostEnv({ [LEAK]: "host", PATH: "/bin" });
    assert(
      host[LEAK] === "host",
      "verifyHostEnv: the one knob the driver's OWN git calls read is kept for the host-side calls",
    );
    assert(
      Object.keys(host).sort().join() === `PATH,${LEAK}`,
      `verifyHostEnv: it keeps nothing beyond the named knob (got ${Object.keys(host).join()})`,
    );
    const absent = verifyHostEnv({ PATH: "/bin" });
    assert(!(LEAK in absent), "verifyHostEnv: an unset knob is not invented");
    const other = verifyHostEnv({ [LEAK]: "host", PATH: "/bin", PI_ENSEMBLE_PARALLEL_WORK: "1" });
    assert(
      !("PI_ENSEMBLE_PARALLEL_WORK" in other),
      "verifyHostEnv: the exception is the ONE named knob, not the whole driver namespace — a second knob still drops",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("7. source canary: every project-command seam routes through the helper");
  const sites: Array<[string, string]> = [
    // The develop shell executor (the #1687 scrub) — unchanged.
    ["work-driver-verify-shell.ts", "execTree(cmd, { ...opts, env: verifyChildEnv(opts?.env) })"],
    ["work-driver-verify.ts", "return shellExecp(cmd, {"],
    ["work-driver-verify.ts", "groupExecp(cmd, { ...opts, env: verifyChildEnv(opts.env) })"],
    ["work-driver-verify-pr17.ts", ": shellExecp(cmd, opts);"],
    ["work-driver-stepback-ci.ts", "shellExecp(cmd, opts);"],
    // #1642: the paths that built their own env or passed none.
    ["work-driver-consolidated-verify.ts", "env: verifyChildEnv(),"],
    ["work-driver-verify-per-worktree.ts", "env: verifyChildEnv(),"],
    ["work-driver-verify-develop-gates.ts", "env: verifyChildEnv(),"],
    ["work-driver-ci-verify.ts", "runVerifyFull(cmd, primaryWorktree, timeoutMs, execFn"],
    ["work-driver-verify-aggregate.ts", "env: verifyChildEnv(),"],
    ["work-driver-cap-checkpoint-typecheck.ts", "env: verifyChildEnv(),"],
    [
      "work-driver-integrate-verify.ts",
      "verifyReportEnv(verifyChildEnv(baseEnv), channel.changeReportFile)",
    ],
    [
      "work-driver-integrate-verify.ts",
      "verifyReportEnv(verifyChildEnv(baseEnv), channel.probeReportFile)",
    ],
    ["work-driver-integrate-verify-flake.ts", "opts.changeEnv ?? verifyChildEnv()"],
    ["work-driver-verify-select-exec.ts", "opts?.env ?? verifyChildEnv()"],
    ["work-driver-verify-select-exec.ts", "verifyReportEnv(verifyChildEnv(), probeReportFile)"],
    ["work-driver-verify-attribution.ts", "opts.probeEnv ?? verifyChildEnv()"],
    // The ci tier's output bound: 1 MiB was the `stdout maxBuffer length
    // exceeded` abort reported in run 6 (#1064).
    ["work-driver-verify-full.ts", "maxBuffer: VERIFY_FULL_MAX_BUFFER"],
    // The baseline probe's OWN git calls take the named host env — computed in
    // the probe, not handed in by a caller that could name any knob it liked.
    ["work-driver-verify-baseline.ts", "const hostEnv = verifyHostEnv();"],
  ];
  const inheritedBy = new Set([
    // The one seam that legitimately reads a snapshot of the parent for the
    // report env — it scrubs it before use, asserted above.
    "work-driver-integrate-verify.ts",
  ]);
  const sources = new Map<string, string>();
  for (const file of new Set(sites.map(([f]) => f))) {
    sources.set(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
  }
  for (const [file, snippet] of sites) {
    assert(sources.get(file)?.includes(snippet) === true, `${file} routes its env: ${snippet}`);
  }
  // A project command must never be handed the parent env raw. The one exempted
  // file builds a report env from a snapshot and scrubs it on the way in.
  const inherit =
    /\?\?\s*process\.env\b(?!\.)|\.\.\.process\.env\b|verifyReportEnv\(\s*process\.env\b|[:=]\s*process\.env\b(?![.\w[])/;
  for (const [file, text] of sources) {
    if (inheritedBy.has(file)) {
      // Allowed only in the exact shape the tests above pin: every raw read is
      // wrapped by the scrub before it becomes a child env.
      const rawReads = text.match(new RegExp(inherit.source, "g")) ?? [];
      const wrapped = (text.match(/verifyChildEnv\(/g) ?? []).length;
      assert(
        wrapped >= rawReads.length && rawReads.length > 0,
        `${file}: reads the parent env only to scrub it (${rawReads.length} reads, ${wrapped} scrubs)`,
      );
      continue;
    }
    assert(!inherit.test(text), `${file} has no env that inherits process.env`);
  }
}
