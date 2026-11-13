#!/usr/bin/env bun
/**
 * Smoke test — the issue-body fetch survives a transient failure, and the
 * empty-body cap stays terminal.
 *
 * Measured defect: a live cycle for issue #700 died 56 ms after step-started
 * with cap-hit `explore-bodies-empty`, before any dispatch ran, because one
 * `gh issue view` hit a connection reset. The cap-hit tail gets zero retries
 * from `work-driver-step-router.ts`, so the retry has to sit around the fetch
 * itself.
 *
 * Both directions are asserted: a transient failure (rejection OR empty
 * stdout) followed by success proceeds, and a body that is still empty after
 * every attempt STILL parks the cycle.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  ISSUE_BODY_TIMEOUT_MS,
  fetchIssueBodyViaGh,
  runExplore,
} from "../src/work-driver-explore.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState } from "../src/workflow-state.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): ExtensionAPI {
  return {
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// Zero the inter-attempt backoff so the retry tests don't sleep.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

/**
 * A repo directory for a cycle case, and the env that case runs in.
 *
 * The issue-body fetch goes through the cycle's forge adapter, and a repo this
 * shallow (a bare `.git/info`, no real git object store, so no remote that could
 * be read) resolves no forge — which refuses the fetch with its own named reason
 * instead of reaching the transient `gh` rejections these cases are about.
 * Naming the forge in env is detection's documented hard override and keeps this
 * file asserting retries; the value is scoped so the pin cannot leak past the
 * case that needed it.
 */
async function withCaseRepo<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
  try {
    return await withEnv({ PI_ENSEMBLE_FORGE: "github" }, () => body(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function capOf(dir: string, issue: number): Promise<string | undefined> {
  const after = await readState(dir, issue);
  const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
  return capHit?.kind === "cap-hit" ? capHit.cap : undefined;
}

// 1. CANARY — a rejected fetch (connection reset) followed by a success
// recovers: the explore dispatch runs and no empty-body cap is emitted.
await withCaseRepo("explore-body-retry-reset-", async (dir) => {
  let attempts = 0;
  let exploreDispatched = false;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 700,
    issueBodyFetcherFn: async (n, _cwd) => {
      attempts++;
      if (attempts === 1) throw new Error("read ECONNRESET");
      return { stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nreal body for #${n}` };
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "explore") exploreDispatched = true;
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      return mkResult({ role: spec.role, text: "stub" });
    },
  };
  await runWorkDriver(ctx);
  assert(attempts === 2, `transient rejection is retried (attempts=${attempts}, want 2)`);
  assert(exploreDispatched, "explore dispatch runs after the retry recovers the body");
  assert(
    (await capOf(dir, 700)) !== "explore-bodies-empty",
    "no 'explore-bodies-empty' cap after a recovered fetch",
  );
});

// 2. CANARY — empty stdout is retryable too. A severed or truncated response
// yields empty output, which is indistinguishable from a genuinely empty
// issue until we have asked again.
await withCaseRepo("explore-body-retry-empty-", async (dir) => {
  let attempts = 0;
  let exploreDispatched = false;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 701,
    issueBodyFetcherFn: async (n, _cwd) => {
      attempts++;
      if (attempts === 1) return { stdout: "" };
      return { stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nreal body for #${n}` };
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "explore") exploreDispatched = true;
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      return mkResult({ role: spec.role, text: "stub" });
    },
  };
  await runWorkDriver(ctx);
  assert(attempts === 2, `empty stdout is retried (attempts=${attempts}, want 2)`);
  assert(exploreDispatched, "explore dispatch runs after an empty first response recovers");
  assert(
    (await capOf(dir, 701)) !== "explore-bodies-empty",
    "no 'explore-bodies-empty' cap after an empty response recovers",
  );
});

// 3. CANARY — the cap stays terminal. A body still empty after every attempt
// halts the cycle exactly as before; the retry must not make this gate
// fail-open. The attempt count is the canary half (1 pre-fix, 3 post-fix);
// the cap assertion is the INVARIANT half — it must hold in both directions.
await withCaseRepo("explore-body-retry-persistent-", async (dir) => {
  let attempts = 0;
  let exploreDispatched = false;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 702,
    issueBodyFetcherFn: async (_n, _cwd) => {
      attempts++;
      return { stdout: "" };
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "explore") exploreDispatched = true;
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      return mkResult({ role: spec.role, text: "stub" });
    },
  };
  await runWorkDriver(ctx);
  assert(attempts === 3, `a persistently empty body is retried to the cap (attempts=${attempts})`);
  assert(
    (await capOf(dir, 702)) === "explore-bodies-empty",
    "INVARIANT: a persistently empty body STILL parks with 'explore-bodies-empty'",
  );
  assert(exploreDispatched === false, "INVARIANT: no explore tokens spent on a doomed cycle");
});

// 4. CANARY — a persistent rejection also exhausts the attempts and parks.
await withCaseRepo("explore-body-retry-rejects-", async (dir) => {
  let attempts = 0;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 703,
    issueBodyFetcherFn: async (_n, _cwd) => {
      attempts++;
      throw new Error("read ECONNRESET");
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      return mkResult({ role: spec.role, text: "stub" });
    },
  };
  await runWorkDriver(ctx);
  assert(
    attempts === 3,
    `a persistently rejecting fetch is retried to the cap (attempts=${attempts})`,
  );
  assert(
    (await capOf(dir, 703)) === "explore-bodies-empty",
    "INVARIANT: a persistently failing fetch STILL parks with 'explore-bodies-empty'",
  );
  const after = await readState(dir, 703);
  const reason = after?.pipelineState.emptyBodyIssues?.[0]?.reason ?? "";
  assert(
    reason.includes("ECONNRESET"),
    `the handoff carries the real error (${reason.slice(0, 80)})`,
  );
});

// 5. CANARY — the production fetcher passes a per-attempt deadline. Node's
// exec has NO default timeout, so retries alone would leave a hung call
// blocking the cycle forever.
let seen: { cwd: string; maxBuffer: number; timeout: number } | undefined;
// The forge is named for this call too: the fetcher builds its adapter through
// detection, and with no forge to build it returns `undefined`, which the
// fetcher refuses before it ever reaches the exec whose options are under test.
await withEnv({ PI_ENSEMBLE_FORGE: "github" }, async () => {
  await fetchIssueBodyViaGh(704, "/repo", async (_cmd, opts) => {
    seen = opts;
    return { stdout: "body" };
  });
});
assert(
  seen?.timeout === ISSUE_BODY_TIMEOUT_MS && ISSUE_BODY_TIMEOUT_MS > 0,
  `gh issue view carries a per-attempt timeout (${seen?.timeout ?? "none"} ms)`,
);

// 6. INVARIANT — PI_ENSEMBLE_TRANSIENT_RETRY=0 restores single-attempt
// behaviour (the documented escape hatch), and the cap still fires. Both env
// pins are scoped, so no case leaks a switch into the next one.
await withEnv({ PI_ENSEMBLE_TRANSIENT_RETRY: "0" }, async () => {
  await withCaseRepo("explore-body-retry-optout-", async (dir) => {
    let attempts = 0;
    const ctx: DriverContext = {
      host: makeFakePi(),
      repoRoot: dir,
      issue: 705,
      issueBodyFetcherFn: async (_n, _cwd) => {
        attempts++;
        return { stdout: "" };
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    assert(attempts === 1, `PI_ENSEMBLE_TRANSIENT_RETRY=0 → one attempt (attempts=${attempts})`);
    assert(
      (await capOf(dir, 705)) === "explore-bodies-empty",
      "escape hatch still parks on an empty body",
    );
  });
});

// 7. CANARY (#1151) — a rejected PRIMARY fetch never reaches the open-point
// gate unchecked. The cycle halts before any explore dispatch and records no
// normalised spec, so the gate cannot be silently skipped on a spec it never read.
await withCaseRepo("explore-body-primary-rejected-", async (dir) => {
  let exploreDispatched = false;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 706,
    issueBodyFetcherFn: async (_n, _cwd) => {
      throw new Error("read ECONNRESET");
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "explore") exploreDispatched = true;
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      return mkResult({ role: spec.role, text: "stub" });
    },
  };
  await runWorkDriver(ctx);
  const after = await readState(dir, 706);
  assert(
    !exploreDispatched && after?.pipelineState.normalisedSpec === undefined,
    "primary fetch rejected: no explore dispatch and no spec reaches the open-point gate",
  );
  assert(
    (await capOf(dir, 706)) === "explore-bodies-empty",
    "primary fetch rejected: the cycle halts at explore-bodies-empty",
  );
});

// 8. CANARY — the primary issue missing from the explore set halts as a
// wiring fault. A single-issue set that does not contain ctx.issue is not a
// bad issue: the explore dispatch completes, the intent verdict is resolved,
// and the primary-body lookup finds nothing. The cycle must halt with
// `step-failed:explore` (evidence names the missing primary) and must not
// record a normalised spec.
await withCaseRepo("explore-body-primary-missing-", async (dir) => {
  const reply = [
    "INTENT-VERDICT: proceed",
    "",
    "## Spec",
    "",
    "### Intent",
    "Add the widget renderer.",
    "",
    "### Deliverables",
    "- D1: add the widget renderer [paths: src/widget.ts]",
    "",
    "### Acceptance criteria",
    "- the widget renders",
    "",
  ].join("\n");
  let exploreDispatches = 0;
  const ctx: DriverContext = {
    host: makeFakePi(),
    repoRoot: dir,
    issue: 707,
    issues: [708],
    issueBodyFetcherFn: async (n, _cwd) => ({
      stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody for #${n}`,
    }),
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "explore") exploreDispatches++;
      return mkResult({ role: spec.role, text: reply });
    },
  };
  const next = await runExplore(ctx, initialState(707, 1_000_000), 1_000_000);
  const capHit = next.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    exploreDispatches === 1,
    `primary-missing: explore dispatches once (${exploreDispatches})`,
  );
  assert(
    capHit?.kind === "cap-hit" && capHit.cap === "step-failed:explore",
    `primary-missing: halts with step-failed:explore (${capHit?.kind === "cap-hit" ? capHit.cap : "no cap-hit"})`,
  );
  assert(
    capHit?.kind === "cap-hit" &&
      capHit.nextStep === "handoff" &&
      (capHit.evidence ?? "").includes("primary issue missing from issue list [708]"),
    "primary-missing: cap routes to handoff and names the missing primary in evidence",
  );
  assert(
    next.pipelineState.normalisedSpec === undefined,
    "primary-missing: no normalised spec reaches the open-point gate",
  );
});

console.log(`\nexit ${exit}`);
process.exit(exit);
