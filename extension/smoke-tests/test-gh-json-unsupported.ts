#!/usr/bin/env bun
/**
 * A gh with no `--json` on `pr checks` (Ubuntu's 2.46.0) answers exit 1
 * `unknown flag: --json`. Every reader of the checks argv must refuse with a
 * reason naming that gh's version and the failing command — the gatherer, the
 * merge guard (whose `-R` must not reach the version probe), forge readiness,
 * the adapter's `prChecks` and lean's ci tier — and none may produce a pass.
 * A failure that is not gh's own unknown-flag answer (a kill) keeps the plain
 * tooling refusal, and a probe that cannot answer reports the version unknown.
 */

import { prChecksCmd } from "../src/forge-commands.ts";
import { checkGithubReadiness } from "../src/forge-merge.ts";
import { createForge } from "../src/forge.ts";
import type { CiDeps } from "../src/lean/ci-deps.ts";
import type { GlForge } from "../src/lean/ci-forge-gl.ts";
import { checksRedReason } from "../src/lean/ci-tier.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import { refuseUnlessCiGreen } from "../src/merge-guard-reads.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { ghDetection } from "./forge-fixtures.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { realPrViewReply } from "./lib/lean-gh-payloads.ts";

const PR = 17;
const HEAD = "a".repeat(40);
const CMD = prChecksCmd("github", PR);
const NAMED = `gh 2.46.0 does not accept --json on \`${CMD}\``;

type Exec = (cmd: string, o?: object) => Promise<{ stdout: string; stderr?: string }>;

/** An old gh: `pr view --json` answers, `pr checks --json` is gh's real unknown-flag exit. */
function oldGh(probe: "ok" | "fails" = "ok", checksErr?: unknown): Exec {
  return async (cmd) => {
    if (cmd.startsWith("gh --version")) {
      if (probe === "fails" || cmd !== "gh --version")
        throw Object.assign(new Error(`Command failed: ${cmd}`), { code: 1, stderr: "" });
      return { stdout: "gh version 2.46.0 (2025-12-13 Ubuntu 2.46.0-4)\nhttps://x\n" };
    }
    if (cmd.startsWith("gh pr view")) return { stdout: realPrViewReply(HEAD, { number: PR }) };
    if (cmd.startsWith(CMD)) {
      throw (
        checksErr ??
        Object.assign(new Error(`Command failed: ${cmd}\nunknown flag: --json\n`), {
          code: 1,
          stdout: "",
          stderr: "unknown flag: --json\n\nUsage:  gh pr checks [<number>] [flags]\n",
        })
      );
    }
    throw new Error(`unexpected exec: ${cmd}`);
  };
}

const ev = await gatherMergeEvidence(oldGh(), "/r", PR, "github");
assert(
  !ev.ok && ev.failureKind === "tooling" && (ev.reason ?? "").includes(NAMED),
  `gatherer: tooling refusal names the gh version and command (${ev.reason})`,
);

const guard = await refuseUnlessCiGreen(oldGh(), "/r", PR, "github", {
  expectedHeadOid: HEAD,
  repoValue: "o/r",
});
assert(
  guard?.block === true &&
    guard.reason.includes("failureKind: tooling") &&
    guard.reason.includes(NAMED),
  `guard: refuses as tooling, version probed without -R (${guard?.reason})`,
);

const ready = await checkGithubReadiness(oldGh(), "/r", PR);
assert(
  !ready.ok && (ready.reason ?? "").includes(NAMED),
  `readiness: refuses naming them (${ready.reason})`,
);

const adapter = await createForge(ghDetection("o", "r"), { execFn: oldGh() })
  .prChecks(PR)
  .then(
    () => "resolved",
    (e: Error) => e.message,
  );
assert(adapter.includes(NAMED), `adapter prChecks: rejects naming them (${adapter})`);

// The ci tier throws at its first read, before the ctx or the GitLab forge are touched.
const lean = await checksRedReason(
  { exec: oldGh(), now: () => 0, sleep: async () => {} } as unknown as CiDeps,
  {} as HandlerCtx,
  "/r",
  PR,
  HEAD,
  1,
  false,
  {} as GlForge,
).then(
  (r) => `returned ${r}`,
  (e: Error) => (e instanceof VerifyInfraError ? e.message : `other: ${e.message}`),
);
assert(lean.includes(NAMED), `lean ci tier: infra throw naming them (${lean})`);

const unknown = await gatherMergeEvidence(oldGh("fails"), "/r", PR, "github");
assert(
  !unknown.ok && (unknown.reason ?? "").includes("gh (version unknown) does not accept --json"),
  `probe failure: the refusal stands, version unknown (${unknown.reason})`,
);

const killed = Object.assign(new Error("unknown flag: --json"), { code: null, killed: true });
const kill = await gatherMergeEvidence(oldGh("ok", killed), "/r", PR, "github");
assert(
  !kill.ok && kill.failureKind === "tooling" && !(kill.reason ?? "").includes("does not accept"),
  `a kill with no exit code stays the plain tooling refusal (${kill.reason})`,
);

process.exit(exit);
