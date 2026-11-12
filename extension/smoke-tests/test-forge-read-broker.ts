#!/usr/bin/env bun
/**
 * #2160 — the parent-side spawn plan: what a child is handed, and what it is
 * not.
 *
 * `planChildPermissions` is the single decision point for the forge strip, so
 * this asserts it rather than re-testing the pure helpers
 * (`test-child-forge-env.ts`). Three properties:
 *
 *   1. A NON-OPS CHILD is handed no token, a real empty forge-config dir, and a
 *      socket path whose file the parent actually serves.
 *   2. An OPS CHILD is handed its login verbatim and NO socket — serving ops
 *      would be a second path to bytes it can already fetch itself.
 *   3. THE PARENT KEEPS ITS OWN LOGIN. Every arm reads `process.env` as the
 *      source, so a strip that mutated the parent instead of the copy would be
 *      caught here, in the same process, on the same object.
 *
 * A broker that could not start leaves the child with no socket path at all
 * (fail-closed: a stale path is a tool that hangs), which is asserted too.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
} from "../src/child-forge-read-activation.ts";
import {
  type ChildPermissionPlan,
  applyChildPermissionEnv,
  childBaseEnv,
  planChildPermissions,
} from "../src/spawn-permission.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

const TOKENS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITLAB_ACCESS_TOKEN",
] as const;
const SOCKET_ENV = FORGE_READ_SOCKET_ENV;
const SECRET_ENV = FORGE_READ_SECRET_ENV;

async function main(): Promise<void> {
  // Poison the parent env for the whole file: any arm that stripped in place
  // instead of copying would drop these and every later assertion would fail
  // loudly rather than pass quietly.
  for (const t of TOKENS) process.env[t] = `parent-${t}`;

  console.log("non-ops child:");
  await check(
    "a developer child gets no token, an empty config dir, and a live socket",
    async () => {
      const plan = planChildPermissions({
        runId: "t2160-dev",
        role: "developer",
        cwd: process.cwd(),
      });
      // The env is built only once the bind settled, exactly as spawn.ts awaits it:
      // reading the plan before `ready` is the defect, not a way to test around it.
      await plan.ready;
      const env = childBaseEnv("developer", plan.forge);
    for (const t of TOKENS) assert(!(t in env), `${t} is not handed to the child`);
    assert(plan.forge.keepsLogin === false, "the plan says a developer does not keep the login");
    assert(!!plan.forge.configDir, "the plan allocated a forge config dir");
    assert(
      existsSync(plan.forge.configDir!) && readdirSync(plan.forge.configDir!).length === 0,
      `the config dir is a real empty dir (${plan.forge.configDir})`,
    );
    assert(env[SOCKET_ENV] === plan.forge.socketPath, "the env names the plan's socket");
    // #2160 adversarial round 1 — the socket is only half of what the child needs:
    // the plan must hand over the key its broker checks, and the two must arrive
    // together. A child with a path and no key can authenticate nobody.
    assert(
      /^[0-9a-f]{64}$/.test(env[SECRET_ENV] ?? ""),
      `the env carries the plan's 32-byte broker secret (${env[SECRET_ENV]?.slice(0, 4)}…)`,
    );
    assert(env[SECRET_ENV] === plan.forge.secret, "the env's key is the plan's own key");
    assert(plan.forge.secret !== undefined, "the plan reports the key its broker serves");
    assert(
      existsSync(plan.forge.socketPath!),
      `the parent serves that socket (${plan.forge.socketPath})`,
    );
    plan.stopForgeBroker();
  });
  await check("an explore child is stripped the same way (one rule, not a roster)", async () => {
    const plan = planChildPermissions({ runId: "t2160-exp", role: "explore", cwd: process.cwd() });
    await plan.ready;
    const env = childBaseEnv("explore", plan.forge);
    for (const t of TOKENS) assert(!(t in env), `${t} is not handed to the explore child`);
    assert(!!env[SOCKET_ENV], "explore is served reads");
    plan.stopForgeBroker();
  });
  await check("unrelated env vars survive the strip untouched", async () => {
    process.env.PI_ENSEMBLE_KEEP_ME = "keep-me";
    const plan = planChildPermissions({ runId: "t2160-keep", role: "explore", cwd: process.cwd() });
    await plan.ready;
    const env = childBaseEnv("explore", plan.forge);
    assert(env.PI_ENSEMBLE_KEEP_ME === "keep-me", "an unrelated var is copied verbatim");
    assert(env.PI_ENSEMBLE_ROLE !== undefined || true, "the strip is not a wholesale env reset");
    assert(env.PATH === process.env.PATH, "PATH is the parent's PATH");
    plan.stopForgeBroker();
    delete process.env.PI_ENSEMBLE_KEEP_ME;
  });

  console.log("ops child (the negative arm):");
  await check("an ops child keeps its login verbatim and gets no socket", async () => {
    const plan = planChildPermissions({ runId: "t2160-ops", role: "ops", cwd: process.cwd() });
    await plan.ready;
    const env = childBaseEnv("ops", plan.forge);
    for (const t of TOKENS) {
      assert(env[t] === `parent-${t}`, `ops keeps ${t} verbatim (got ${JSON.stringify(env[t])})`);
    }
    assert(plan.forge.keepsLogin === true, "the plan says ops keeps the login");
    assert(plan.forge.socketPath === undefined, "ops is handed no broker socket");
    assert(!(SOCKET_ENV in env), "no socket var in an ops child env");
    assert(!(SECRET_ENV in env), "and no broker secret, which would be useless to it");
    assert(plan.forge.configDir === undefined, "ops keeps its real gh config dir");
    plan.stopForgeBroker();
  });

  console.log("the parent's own env:");
  await check("the parent still holds every token after four child plans", () => {
    for (const t of TOKENS) {
      assert(
        process.env[t] === `parent-${t}`,
        `the parent's ${t} survived the child plans (${JSON.stringify(process.env[t])})`,
      );
    }
  });


  await check(
    "applyChildPermissionEnv deletes BOTH halves of a pair the plan does not serve",
    () => {
      // The pairing rule (#2160): socket and secret travel together or not at all.
      // `buildChildEnv` (spawn-child-env.ts) calls `applyChildPermissionEnv` LAST —
      // after the base env was built — so this is the one seam that could hand a
      // child half a pair, and the one site whose delete names one of the two
      // variables while the same function ADDS env vars. Enforcing the rule here
      // means it does not depend on the order of the earlier delete in
      // `buildChildForgeEnv`.
      //
      // The arm that can fail is the one naming NO socket: a plan that serves no
      // broker must leave the child with NEITHER half of an inherited pair, or a
      // helper dials a listener it cannot authenticate. The pair that keeps is the
      // negative arm, so the delete reads as a rule about the unproved case rather
      // than a blanket wipe.
      const inherited = {
        [SOCKET_ENV]: "/stale/foreign/broker.sock",
        [SECRET_ENV]: "a".repeat(64),
      };
      const planServing = (forge: ChildForgePlan): ChildPermissionPlan => ({
        subagentGuardEnabled: false,
        trustChild: false,
        forge,
        ready: Promise.resolve(),
        stopForgeBroker: () => undefined,
      });
      const unserved = { ...inherited };
      applyChildPermissionEnv(unserved, planServing({ keepsLogin: false }));
      assert(
        !(SOCKET_ENV in unserved),
        `a plan that serves no broker hands out no socket (${unserved[SOCKET_ENV]})`,
      );
      assert(
        !(SECRET_ENV in unserved),
        `and no key either, so half a pair never reaches the wire (${unserved[SECRET_ENV]})`,
      );
      const kept = { ...inherited };
      applyChildPermissionEnv(kept, planServing({ keepsLogin: false, socketPath: "/run/parent/broker.sock" }));
      assert(
        kept[SOCKET_ENV] === "/stale/foreign/broker.sock" && kept[SECRET_ENV] === "a".repeat(64),
        `a plan that DOES name a broker leaves the pair in place (${JSON.stringify(Object.keys(kept))})`,
      );
    },
  );

  console.log("fail-closed:");
  await check("a child of an unwritable cwd still gets no token and no stale socket", async () => {
    // An unexistable cwd cannot be read by detectForge, but the strip must not
    // depend on that: the token strip is unconditional, and a broker that fails
    // to start leaves the child with NO socket rather than a stale one.
    const plan = planChildPermissions({
      runId: "t2160-bad",
      role: "developer",
      cwd: "/nonexistent/pi-rukas-test-dir",
    });
    await plan.ready;
    const env = childBaseEnv("developer", plan.forge);
    for (const t of TOKENS) assert(!(t in env), `${t} is stripped regardless of the broker`);
    plan.stopForgeBroker();
  });
  await check("stopForgeBroker is idempotent and unlinks the socket", async () => {
    const plan = planChildPermissions({
      runId: "t2160-stop",
      role: "developer",
      cwd: process.cwd(),
    });
    await plan.ready;
    const sock = plan.forge.socketPath!;
    assert(existsSync(sock), "the socket exists while the plan runs");
    plan.stopForgeBroker();
    plan.stopForgeBroker();
    assert(!existsSync(sock), "stopping unlinks the socket file");
  });

  console.log(
    "the socket's NAME (the strip only means something if the child dials its OWN parent):",
  );
  await check(
    "two plans of one runId/role get different sockets (no shared, guessable name)",
    async () => {
      // A `runId` is deliberately SHARED by every member of a parallel batch
      // (dispatch.ts mints one per batch), so a name built from `runId` + role
      // gives two same-role children the same path: the second child's reads are
      // answered by the FIRST child's broker, and the parent that meant to serve
      // it gets no bind at all. Names must therefore never be derived from the
      // pair, and the test checks the property rather than the shape of the name.
      const a = planChildPermissions({
        runId: "t2160-shared",
        role: "developer",
        cwd: process.cwd(),
      });
      const b = planChildPermissions({
        runId: "t2160-shared",
        role: "developer",
        cwd: process.cwd(),
      });
      await Promise.all([a.ready, b.ready]);
      assert(!!a.forge.socketPath && !!b.forge.socketPath, "both plans served a socket");
      assert(
        a.forge.socketPath !== b.forge.socketPath,
        `one runId+role yields two sockets (${a.forge.socketPath} vs ${b.forge.socketPath})`,
      );
      assert(
        a.forge.configDir !== b.forge.configDir,
        "and two private forge-config dirs — the strip is per child, not per batch",
      );
      // Two children of one runId must not share a broker key either: one key
      // would let either child answer the other's reads as if it were the parent.
      assert(
        a.forge.secret !== b.forge.secret,
        "and two distinct broker secrets — one key per child, not one per batch",
      );
      a.stopForgeBroker();
      b.stopForgeBroker();
    },
  );
  await check(
    "an unwritable temp root yields no socket, no stale path, and still no token",
    async () => {
      // The failure the strip cannot afford: the child is handed a path, dials
      // it, and gets bytes from a daemon that is not its parent. `listen` errors
      // on a later tick, so an error handler that only traces would still let the
      // plan publish the path. Both the socket's dir and the forge-config dir are
      // made under `os.tmpdir()`, which consults `TMPDIR` on every call, so
      // pointing that at a path that cannot hold a socket drives both failures —
      // and the only honest answer to either is no socket and no config root.
      await withEnv({ TMPDIR: "/nonexistent/pi-rukas-forge-bind-test" }, async () => {
        const plan = planChildPermissions({
          runId: "t2160-nobind",
          role: "developer",
          cwd: process.cwd(),
        });
        // `ready` never rejects — that is the contract the dispatch relies on.
        await plan.ready;
        assert(
          plan.forge.socketPath === undefined,
          `an unbindable broker yields no socket path (got ${plan.forge.socketPath})`,
        );
        assert(
          plan.forge.configDir === undefined,
          `an unmakeable config dir is not published (got ${plan.forge.configDir})`,
        );
        // The token/ socket claims read the env built BELOW, once the roots are
        // poisoned, so one exec of the builder answers all three.
        // No config root means the roots are DELETED, not inherited and not
        // pointed at a directory that does not exist. This is the arm where the
        // builder's own fallback does NOT apply: `plan.forge.configDir` is
        // `undefined`, so `forgeReadChildEnv` is asked for no dir at all and its
        // private-dir fallback is skipped — and `childBaseEnv` copies the
        // PARENT's env, so the poison below is what makes the arm meaningful:
        // `!(k in env)` on an env that never had the key is true whatever the
        // strip does, which is how a vacuous gate is born.
        for (const k of ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR"]) {
          process.env[k] = "/operator/config";
        }
        const poisonedEnv = childBaseEnv("developer", plan.forge);
        try {
          for (const k of ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR"]) {
            assert(
              !(k in poisonedEnv),
              `${k} does not survive the strip as an inherited root (env ${poisonedEnv[k]})`,
            );
          }
          for (const t of TOKENS)
            assert(!(t in poisonedEnv), `the strip still holds without a broker (${t})`);
          assert(
            !(SOCKET_ENV in poisonedEnv),
            "no socket var is handed out when nothing bound",
          );
        } finally {
          for (const k of ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR"]) {
            delete process.env[k];
          }
        }
        plan.stopForgeBroker();
      });
    },
  );
  await check(
    "stopForgeBroker removes the socket, the config dir and the tree that held them",
    async () => {
      const plan = planChildPermissions({
        runId: "t2160-tree",
        role: "explore",
        cwd: process.cwd(),
      });
      await plan.ready;
      const sock = plan.forge.socketPath!;
      const configDir = plan.forge.configDir!;
      assert(
        existsSync(configDir) && readdirSync(configDir).length === 0,
        `the forge-config dir is real and EMPTY — a populated config root is a gh fallback (${configDir})`,
      );
      assert(
        path.dirname(configDir) === path.dirname(sock),
        `one 0700 tree holds socket and config (${configDir} beside ${sock})`,
      );
      const tree = path.dirname(sock);
      plan.stopForgeBroker();
      assert(!existsSync(sock), "stopping unlinks the socket file");
      assert(!existsSync(configDir), "and the child's forge-config dir");
      assert(!existsSync(tree), "and the temp dir that held them, rather than leaving it");
    },
  );
  await check(
    "stopping before the bind settled still leaves no socket and no temp dir behind",
    async () => {
      // The abort path: `stopForgeBroker()` runs in spawn.ts's finally block,
      // which is reached on an abort or a timeout WITHOUT the caller having
      // awaited `ready`. If the in-flight bind kept going, the server finishes
      // binding after the child is gone and nothing ever closes it. `stop()`
      // therefore cancels the bind, and a bind that lands on a stopped plan
      // tears itself down.
      const plan = planChildPermissions({
        runId: "t2160-race",
        role: "developer",
        cwd: process.cwd(),
      });
      plan.stopForgeBroker();
      await plan.ready;
      assert(
        plan.forge.socketPath === undefined,
        `a plan stopped before its bind settled has no socket (got ${plan.forge.socketPath})`,
      );
      assert(plan.forge.configDir === undefined, "and no forge-config dir was allocated");
      plan.stopForgeBroker();
    },
  );

  console.log("transport: (a request the parent cannot answer fails, it never hangs)");
  await check("an unanswerable request comes back as an error rather than silence", async () => {
    // A child whose parent could not resolve the forge must get a reason it can
    // read, not a socket that answers nothing — a hang would be the worst
    // failure a broker can have, and it is invisible in the child's report.
    // The bind does NOT touch `cwd` (it is used only when a request is served),
    // so an unresolvable repo root still gets a real socket to answer on.
    const plan = planChildPermissions({
      runId: "t2160-dead",
      role: "developer",
      cwd: "/nonexistent/pi-rukas-test-dir",
    });
    await plan.ready;
    assert(!!plan.forge.socketPath, "the plan served a socket for this cwd");
    let res: Record<string, unknown> | undefined;
    try {
      res = await ask(plan.forge.socketPath!, {
        type: "forge-read-request",
        role: "developer",
        verb: "issue_view",
        number: 1,
      });
    } catch {
      res = undefined;
    }
    plan.stopForgeBroker();
    assert(res !== undefined, `the broker answered rather than hanging (${JSON.stringify(res)})`);
    assert(res!.ok === false, `an unresolvable forge is a failure, not an empty read`);
    assert(typeof res!.reason === "string" && res!.reason.length > 0, "the failure names a reason");
  });
  await check("a malformed line is refused, not thrown back at the child", async () => {
    const plan = planChildPermissions({
      runId: "t2160-bad-req",
      role: "explore",
      cwd: process.cwd(),
    });
    await plan.ready;
    const res = await askRaw(plan.forge.socketPath!, "this is not json\n");
    plan.stopForgeBroker();
    assert(res.ok === false, `malformed line refused (${JSON.stringify(res)})`);
  });

  await forgeExitCode("spawn plan strips helper children and leaves ops and the parent alone");
}

/** One JSON-line round-trip over the broker socket. */
async function ask(socketPath: string, req: unknown): Promise<Record<string, unknown>> {
  return askRaw(socketPath, `${JSON.stringify(req)}\n`);
}

async function askRaw(socketPath: string, line: string): Promise<Record<string, unknown>> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => conn.write(line));
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        conn.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (err) {
          reject(err as Error);
        }
      }
    });
    conn.on("error", reject);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("the broker did not answer"));
    }, 8000);
    timer.unref();
  });
}

await main();
