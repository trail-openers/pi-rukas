#!/usr/bin/env bun
/**
 * #2160 — a spawned helper child carries no forge login.
 *
 * The five forge token variables used to pass straight through the child env,
 * and `gh`/`glab` fall back to the operator's config dir when none is set, so
 * a developer or reviewer child could run a credentialed `gh pr merge` with the
 * operator's own access. The classifier was the only thing in the way. Reads now
 * go through the parent-served `forge_read` tool, so the child needs no login —
 * and this test is the SOLE detector that it is gone, because no other gate ever
 * asserted anything about forge credentials reaching children.
 *
 * Modelled on test-inherited-repo-env.ts: poison `process.env`, run
 * `dispatchCore` (the spawn.ts site) with a stub pi that dumps its env, and
 * `attemptReattach` (the resume site) with an injected `spawnReattach` that
 * captures the env it was handed. The negative arm is load-bearing: an ops
 * dispatch under the SAME poison must show all five tokens verbatim, or a strip
 * that deleted everyone's tokens would pass this file green.
 *
 * The pure half (no spawn at all) sits at the bottom: `childEnvFor` is the one
 * helper both construction paths call, so its behaviour is asserted on a literal
 * env too.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { dispatchCore } from "../src/dispatch.ts";
import {
  FORGE_CONFIG_DIR_VARS,
  FORGE_TOKEN_VARS,
  stripForgeCredentials,
} from "../src/child-forge-env.ts";
import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
} from "../src/child-forge-read-activation.ts";
import { attemptReattach } from "../src/work-driver-resume-reattach.ts";
import { childEnvFor } from "../src/write-fence-contract.ts";
import { withEnv } from "./lib/env-scope.ts";

const SOCKET_ENV = FORGE_READ_SOCKET_ENV;
const SECRET_ENV = FORGE_READ_SECRET_ENV;
/** A socket path no parent of this child ever served. */
const STALE_SOCKET = "/tmp/pi-rukas-forge-read-STALE/broker.sock";
/** The key that came with it: a pair is one credential, so the poison is a pair. */
const STALE_SECRET = "a".repeat(64);


let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The poison: five tokens, and both config roots pointed at a populated dir. */
function poisonEnv(): Record<string, string> {
  const poison: Record<string, string> = {
    PI_ENSEMBLE_ALLOW_LIVE_SPAWN: "1",
    PI_ENSEMBLE_QUIET_STATUS: "1",
    // #2160 lens fix — the reattach path serves no broker, so a child that
    // inherits this from an earlier spawn would dial a socket no parent of
    // its own is listening on. The reattach builder reads `process.env`, so
    // that is where the poison belongs, and where the reattach arm asserts.
    // #2160 adversarial round 1 — the poison is the whole PAIR. An inherited key
    // beside an inherited path is a live credential, and neither half may reach a
    // child this parent serves no broker for.
    [SOCKET_ENV]: STALE_SOCKET,
    [SECRET_ENV]: STALE_SECRET,
  };
  for (const [i, v] of FORGE_TOKEN_VARS.entries()) poison[v] = `poison-token-${i}`;
  return poison;
}

const dir = mkdtempSync(path.join(tmpdir(), "child-forge-creds-"));

try {
  // ── spawn.ts: the dispatched child gets a stripped env ─────────────────
  const envFile = path.join(dir, "child.env");
  const stub = path.join(dir, "pi-stub.sh");
  writeFileSync(
    stub,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }\nenv > "${envFile}.tmp" && mv "${envFile}.tmp" "${envFile}"\n`,
  );
  chmodSync(stub, 0o755);

  /**
   * Run one dispatch against the stub pi and return the env the child recorded.
   * Empty string when the stub never ran — which is why every caller asserts the
   * `GIT_EDITOR=true` premise BEFORE its own claims (see each block): a token
   * assertion on an empty dump is vacuously true, so a silent stub failure must
   * never be readable as a pass.
   */
  async function dispatchAndDumpEnv(role: string): Promise<string> {
    if (existsSync(envFile)) rmSync(envFile);
    const host: DispatchHost = { sendUserMessage: () => {} };
    const done = dispatchCore(host, { role, prompt: "stub", cwd: dir }, { skipDeck: true });
    const end = Date.now() + 10_000;
    while (!existsSync(envFile) && Date.now() < end) await sleep(20);
    await Promise.race([done.catch(() => undefined), sleep(10_000)]);
    return existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  }

  /**
   * The per-child forge config dir the strip names in a captured child env.
   *
   * Asserted on the NAME the child was handed, not on `existsSync` of that name:
   * `stopForgeBroker()` removes the dir with the broker's temp tree when the child
   * exits, so by the time this dispatch has resolved the path is `ENOENT` whether
   * the redirect worked or was never allocated — a check that cannot tell those
   * apart is not a gate. The parent therefore verifies its own redirect inside the
   * `ready` window (`startForgeBroker` in spawn-permission.ts traces a redirect
   * that fails to point BOTH roots at a real empty dir), and
   * `test-forge-read-broker.ts` asserts that property on the plan it created, at
   * the instant the plan still holds the answer.
   */
  function assertRedirectedConfigRoot(childEnv: string, label: string): void {
    for (const v of FORGE_CONFIG_DIR_VARS) {
      const value = childEnv.match(new RegExp(`^${v}=(.*)$`, "m"))?.[1]?.trim() ?? "";
      assert(
        value.includes("pi-rukas-forge-config-"),
        `${label}: ${v} is redirected at a per-child forge config dir (got "${value}")`,
      );
    }
  }

  // ── (a) non-ops: no token reaches the child, config roots are an empty dir ──
  {
    const poison = { ...poisonEnv(), PI_ENSEMBLE_PI_BIN: stub };
    let childEnv = "";
    await withEnv(poison, async () => {
      childEnv = await dispatchAndDumpEnv("developer");
    });
    const stubRan = /^GIT_EDITOR=true$/m.test(childEnv);
    assert(stubRan, "the stub child ran and recorded its env");
    // The block's own premise: every claim below reads `childEnv`, and each of
    // them is an ABSENCE assertion that an empty dump satisfies vacuously
    // (`!/^GH_TOKEN=/m.test("")` is true). Without this gate a stub that never
    // spawned would report the whole spawn-site strip green.
    if (!stubRan) {
      assert(false, "spawn.ts: the developer arms are SKIPPED — no env was recorded to check");
    } else {
      for (const v of FORGE_TOKEN_VARS) {
        assert(
          !new RegExp(`^${v}=`, "m").test(childEnv),
          `spawn.ts: ${v} never reaches the developer child env`,
        );
      }
      // #2160 adversarial round 1 — the nested-child rule, asserted on the REAL
      // dispatch env rather than on the helper in isolation: a child whose own
      // plan bound no broker carries NEITHER half of a pair it inherited. The
      // broker is per child, so an inherited pair is stripped rather than
      // trusted — a helper that spawned a helper would otherwise hand on a live
      // credential it never earned, and the reads of a child this parent never
      // planned for would be answered with this parent's forge login.
      assert(
        !childEnv.includes(`${SOCKET_ENV}=${STALE_SOCKET}`),
        "spawn.ts: an inherited forge-read socket path does not reach the child",
      );
      assert(
        !childEnv.includes(`${SECRET_ENV}=${STALE_SECRET}`),
        "spawn.ts: an inherited forge-read secret does not reach the child",
      );
      assertRedirectedConfigRoot(childEnv, "spawn.ts (developer)");
    }
  }

  // ── (b) ops keeps all five verbatim — the arm that can fail ────────────
  {
    const poison = { ...poisonEnv(), PI_ENSEMBLE_PI_BIN: stub };
    let childEnv = "";
    await withEnv(poison, async () => {
      childEnv = await dispatchAndDumpEnv("ops");
    });
    const stubRan = /^GIT_EDITOR=true$/m.test(childEnv);
    assert(stubRan, "the stub child ran for the ops dispatch");
    // Same premise gate: this is the negative arm, and an empty dump would leave
    // every "ops keeps the token" claim below red for the wrong reason.
    if (stubRan) {
      for (const [i, v] of FORGE_TOKEN_VARS.entries()) {
        assert(
          new RegExp(`^${v}=poison-token-${i}$`, "m").test(childEnv),
          `spawn.ts: ops keeps ${v} verbatim (the negative arm — a strip that hit ops too would fail here)`,
        );
      }
    }
  }

  // ── resume reattach: the second child-env construction site ────────────
  for (const role of ["developer", "explore", "adversarial-developer", "code-review-specialist"]) {
    let reattachEnv: Record<string, string> = {};
    await withEnv(poisonEnv(), async () => {
      await attemptReattach("/tmp/none.json", "develop", role, 1_000, async (_a, env) => {
        reattachEnv = env;
        return { exitCode: 1, stdout: "", stderr: "" };
      });
    });
    assert(Object.keys(reattachEnv).length > 0, `reattach: the ${role} child env was captured`);
    assert(
      !(SOCKET_ENV in reattachEnv),
      `reattach: a ${role} reattach dials no socket the parent did not serve (got ${reattachEnv[SOCKET_ENV]})`,
    );
    for (const v of FORGE_TOKEN_VARS) {
      assert(
        !(v in reattachEnv),
        `reattach: no ${v} reaches the reattached ${role} child`,
      );
    }
    for (const v of FORGE_CONFIG_DIR_VARS) {
      const value = reattachEnv[v] ?? "";
      assert(
        value.includes("pi-rukas-forge-config-") &&
          existsSync(value) &&
          readdirSync(value).length === 0,
        `reattach: the reattached ${role} child's ${v} is an empty per-child dir`,
      );
    }
  }

  {
    let reattachEnv: Record<string, string> = {};
    await withEnv(poisonEnv(), async () => {
      await attemptReattach("/tmp/none.json", "merge", "ops", 1_000, async (_a, env) => {
        reattachEnv = env;
        return { exitCode: 1, stdout: "", stderr: "" };
      });
    });
    for (const [i, v] of FORGE_TOKEN_VARS.entries()) {
      assert(
        reattachEnv[v] === `poison-token-${i}`,
        `reattach: an ops reattach keeps ${v} verbatim`,
      );
    }
  }

  // ── the pure helper: one exported strip both paths import ──────────────
  {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    for (const v of FORGE_TOKEN_VARS) env[v] = "tok";
    const removed = stripForgeCredentials(env, "explore", "/empty/child-dir");
    assert(
      FORGE_TOKEN_VARS.every((v) => !(v in env)) && removed.length === FORGE_TOKEN_VARS.length,
      "stripForgeCredentials DELETES all five tokens (no undefined-valued key survives)",
    );
    assert(
      FORGE_CONFIG_DIR_VARS.every((v) => env[v] === "/empty/child-dir"),
      "stripForgeCredentials points both config roots at the per-child dir",
    );
    assert(env.PATH === "/bin", "unrelated env survives the strip");

    const opsEnv: Record<string, string | undefined> = {};
    for (const v of FORGE_TOKEN_VARS) opsEnv[v] = "tok";
    for (const v of FORGE_CONFIG_DIR_VARS) opsEnv[v] = "/operator/config";
    const opsRemoved = stripForgeCredentials(opsEnv, "ops", "/empty/child-dir");
    assert(
      opsRemoved.length === 0 &&
        FORGE_TOKEN_VARS.every((v) => opsEnv[v] === "tok") &&
        FORGE_CONFIG_DIR_VARS.every((v) => opsEnv[v] === "/operator/config"),
      "stripForgeCredentials is a no-op for ops (tokens and config roots untouched)",
    );
  }

  // ── the strip is one helper both spawn sites import (canary) ───────────
  {
    const src = path.resolve(import.meta.dirname, "..", "src");
    const spawn = readFileSync(path.join(src, "spawn.ts"), "utf8");
    const reattach = readFileSync(path.join(src, "work-driver-resume-reattach.ts"), "utf8");
    const helper = readFileSync(path.join(src, "child-forge-env.ts"), "utf8");
    // The env assembly moved to spawn-child-env.ts (#2160) when spawn.ts reached
    // the §12 cap; the canary follows it, because the rule it pins is "the spawn
    // path builds its child env through the one shared forge-env helper".
    const spawnEnv = readFileSync(path.join(src, "spawn-child-env.ts"), "utf8");
    assert(
      /from "\.\/child-forge-env\.ts"/.test(spawn) ||
        /childBaseEnv\(role, plan\.forge\)/.test(spawnEnv) ||
        /childBaseEnv\(spec\.role, permissions\.forge\)/.test(spawn),
      "canary: the spawn path builds its child env through the shared forge-env helper",
    );
    assert(
      /forgeReadChildEnv\(process\.env, role\)/.test(reattach),
      "canary: work-driver-resume-reattach.ts imports and calls the same helper",
    );
    assert(
      // The delete may be written `delete env[name]` or
      // `Reflect.deleteProperty(env, name)` — the two are the same operation, and
      // the second is what keeps biome's `noDelete` quiet without a suppression.
      // What must NOT appear is an `undefined` assignment: that is the autofix
      // whose string "undefined" this helper exists to avoid.
      (/delete env\[name\]/.test(helper) ||
        /Reflect\.deleteProperty\(env,\s*name\)/.test(helper)) &&
        !/env\[[^\]]+\]\s*=\s*undefined;/.test(helper) &&
        !/env\.\w+\s*=\s*undefined;/.test(helper),
      "canary: the helper deletes keys rather than assigning undefined",
    );
    assert(
      /SUBAGENT_ROLE_NAMES|keepsForgeLogin/.test(helper) &&
        /OPS_ROLE\s*=\s*"ops"/.test(helper),
      "canary: the role split is one predicate naming the ops literal (no restated role list)",
    );
  }

  // ── no non-ops child env carries a token, on any construction path ─────
  {
    const src = path.resolve(import.meta.dirname, "..", "src");
    // A child env built by copying the parent's must reach the shared strip. The
    // pattern has to match what the tree actually writes (`{ ...process.env }`)
    // and not just one spelling of it: a canary whose regex matches no file
    // reports "every construction reaches the strip" for a set it never opened.
    // The five sites that DO copy `process.env` today spawn neither a Pi child
    // nor a credentialed forge read (a notify hook, a `git show`, the headless
    // supervisor), so they are out of the strip's contract — which is why the
    // gate is an allow-list of named files rather than "all files": a NEW
    // copier is an offender until someone either routes it through the strip or
    // states here why it needs none.
    const exempt = new Set([
      "headless/build.ts", // re-execs this CLI with the supervised marker
      "headless/supervise.ts", // same
      "work-notify.ts", // the desktop-notify hook, no forge access
      "review-findings-head.ts", // `git show`, read-only
      "work-driver-integrate-verify.ts", // driver-side git/gh verify, not a child env
    ]);
    const offenders: string[] = [];
    const inspected: string[] = [];
    for (const f of readdirSync(src, { recursive: true })) {
      if (!f.endsWith(".ts") || f.startsWith("node_modules")) continue;
      if (f === "child-forge-env.ts") continue;
      const text = readFileSync(path.join(src, f), "utf8");
      if (!/\.\.\.process\.env\b/.test(text)) continue;
      inspected.push(f);
      if (
        !exempt.has(f) &&
        !text.includes("child-forge-env.ts") &&
        !text.includes("childBaseEnv")
      ) {
        offenders.push(f);
      }
    }
    assert(
      inspected.length > 0,
      `non-vacuity: the copier scan inspected ${inspected.length} file(s) (${inspected.join(", ")})`,
    );
    assert(
      offenders.length === 0,
      `every process.env-copying child-env construction reaches the strip helper${offenders.length ? ` (offenders: ${offenders.join(", ")})` : ""}`,
    );
  }

  // ── the strip is asserted at the pure seam too (childEnvFor) ───────────
  {
    const env: Record<string, string | undefined> = { PATH: "/bin" };
    for (const v of FORGE_TOKEN_VARS) env[v] = "tok";
    for (const v of FORGE_CONFIG_DIR_VARS) env[v] = "/operator/config";
    const out = childEnvFor(env, "explore");
    assert(
      FORGE_TOKEN_VARS.every((v) => !(v in out)),
      "childEnvFor deletes the five forge tokens for a non-ops role",
    );
    // The arm the token check cannot cover: an inherited root satisfies a
    // redirected-NAME assertion whenever the ambient var already names a dir, so
    // the only thing that catches a strip that leaves it in place is asserting —
    // on a one-arg call, with no dir allocated — that it is gone.
    assert(
      FORGE_CONFIG_DIR_VARS.every((v) => !(v in out)),
      `childEnvFor deletes an inherited config root when it has no dir to redirect to (${FORGE_CONFIG_DIR_VARS.map((v) => `${v}=${out[v]}`).join(", ")})`,
    );
    const redirected = childEnvFor({ ...env, GH_TOKEN: "tok" }, "explore", "/empty/child-dir");
    assert(
      FORGE_CONFIG_DIR_VARS.every((v) => redirected[v] === "/empty/child-dir"),
      "childEnvFor redirects both roots when the caller allocated one",
    );
    const opsOut = childEnvFor({ ...env, PI_ENSEMBLE_ROLE: "ops" }, "ops");
    assert(
      FORGE_TOKEN_VARS.every((v) => opsOut[v] === "tok") &&
        FORGE_CONFIG_DIR_VARS.every((v) => opsOut[v] === "/operator/config"),
      "childEnvFor leaves an ops child's login and roots verbatim (the negative arm)",
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exit);
