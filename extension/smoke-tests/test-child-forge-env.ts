/**
 * #2160 — the env the parent hands a child, and the role gate on the broker.
 *
 * Pure logic, so this is the fast half of the pair; the socket round-trip and
 * the executor contract live in `test-forge-read-broker.ts`.
 */

import { existsSync, readdirSync } from "node:fs";
import {
  FORGE_CONFIG_DIR_VARS,
  FORGE_TOKEN_VARS,
  buildChildForgeEnv,
  forgeReadChildEnv,
  keepsForgeLogin,
  stripForgeCredentials,
} from "../src/child-forge-env.ts";
import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
} from "../src/child-forge-read-activation.ts";
import { newForgeReadSecret } from "../src/forge-read-auth.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

const SOCKET_ENV = FORGE_READ_SOCKET_ENV;
const SECRET_ENV = FORGE_READ_SECRET_ENV;

/** A copy, so a check that mutates cannot leak into the next one. */
const childBase = (): Record<string, string> => ({
  PATH: "/usr/bin",
  HOME: "/home/dev",
  PI_ENSEMBLE_ROLE: "developer",
});

/** The real child-env builder, with the socket path the test plays the parent's. */
const forgeReadEnv = (source: Record<string, string>, role: string): Record<string, string> =>
  forgeReadChildEnv(source, role, role === "ops" ? undefined : "/run/parent/broker.sock");

const TOKENS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITLAB_ACCESS_TOKEN",
] as const;

async function main(): Promise<void> {
  console.log("role gate:");
  await check("ops is refused the broker; every other role is served", () => {
    assert(keepsForgeLogin("ops") === false || keepsForgeLogin("ops") === true, "gate is total");
    assert(keepsForgeLogin("OPS") === keepsForgeLogin("ops"), "the gate is case-insensitive");
    for (const role of [
      "developer",
      "explore",
      "adversarial-developer",
      "code-review-specialist",
      "",
    ]) {
      assert(keepsForgeLogin(role) === false, `${role || "(unset)"} is a stripped helper child`);
    }
    assert(keepsForgeLogin("ops") === true, "ops is the one role that keeps its login");
  });

  console.log("child env:");
  await check(
    "an inherited operator config root does not survive a token-less child",
    () => {
      // The strip's whole purpose is that a helper has no login, and a config
      // root is half of one: `gh` reads an `hosts.yml`/`oauth_token` out of
      // `GH_CONFIG_DIR` with no token in the env at all. So when no replacement
      // dir is available the roots are DELETED with the tokens, never inherited.
      const polluted = {
        ...childBase(),
        GH_TOKEN: "tok",
        GITHUB_TOKEN: "tok",
        GITLAB_TOKEN: "tok",
        GH_ENTERPRISE_TOKEN: "tok",
        GITLAB_ACCESS_TOKEN: "tok",
        GH_CONFIG_DIR: "/operator/gh",
        GLAB_CONFIG_DIR: "/operator/glab",
      };
      for (const role of ["developer", "explore"]) {
        const stripped = stripForgeCredentials({ ...polluted }, role, "");
        for (const k of FORGE_CONFIG_DIR_VARS) {
          assert(
            !(k in stripped),
            `${role}: no config root survives an empty configDir (${k}=${stripped[k]})`,
          );
        }
        assert(
          stripped.length === FORGE_TOKEN_VARS.length,
          `${role}: the tokens are reported as removed`,
        );
      }
      // The pure seam of the same rule: no dir allocated, so an inherited
      // operator root must still not survive.
      const built = buildChildForgeEnv({ ...polluted, PATH: "/bin" }, "developer", "");
      for (const k of [...TOKENS, ...FORGE_CONFIG_DIR_VARS]) {
        assert(!(k in built), `no ${k} in an env built with no config root`);
      }
      // The negative arm: an ops child handed the same env keeps its roots.
      const ops = buildChildForgeEnv(
        { ...polluted, PI_ENSEMBLE_ROLE: "ops", PATH: "/bin" },
        "ops",
        "",
      );
      assert(
        ops.GH_CONFIG_DIR === "/operator/gh" && ops.GLAB_CONFIG_DIR === "/operator/glab",
        "an ops child keeps both config roots verbatim",
      );
    },
  );
  await check(
    "no token survives into the child env, unrelated vars do", () => {
    const parent: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      PI_ENSEMBLE_ROLE: "developer",
      PI_ENSEMBLE_SOMETHING: "keep-me",
    };
    for (const t of TOKENS) parent[t] = `parent-${t}`;
    const env = forgeReadEnv(parent, "developer");
    for (const t of TOKENS) assert(!(t in env), `${t} is not in the child env`);
    assert(env.PI_ENSEMBLE_SOMETHING === "keep-me", "unrelated vars survive");
    assert(env.PI_ENSEMBLE_GIT_REPO_OWNER === undefined, "the strip is not a rename");
  });
  await check("the socket path is the parent's, verbatim, and never the env's", () => {
    const env = forgeReadEnv(
      { ...childBase(), [SOCKET_ENV]: "/spoofed/by/the/operator" },
      "developer",
    );
    assert(
      env[SOCKET_ENV] === "/run/parent/broker.sock",
      `the parent's path wins (got ${env[SOCKET_ENV]})`,
    );
    assert(forgeReadEnv(childBase(), "ops")[SOCKET_ENV] === undefined, "ops gets no socket");
  });
  await check(
    "a child whose parent served no broker holds no socket path at all",
    () => {
      // The reattach path (`work-driver-resume-reattach.ts`) calls the builder
      // with NO socket: it serves none. An inherited
      // `PI_ENSEMBLE_FORGE_READ_SOCKET` — from an earlier spawn of this child's
      // role, or from an outer pi-rukas — must not survive into a child that
      // has no parent on the other end of it: a socket the parent did not
      // serve is a socket someone else may be listening on, and this one
      // answers CONTENT.
      const stale = "/tmp/pi-rukas-forge-read-STALE/broker.sock";
      for (const role of ["developer", "explore", "adversarial-developer", "code-review-specialist"]) {
        const env = forgeReadChildEnv({ ...childBase(), [SOCKET_ENV]: stale }, role);
        assert(!(SOCKET_ENV in env), `${role}: a reattach child dials no socket (${env[SOCKET_ENV]})`);
      }
      // The negative arm: an ops child is served a socket by no broker either
      // (ops keeps its login and reads the forge itself), and the delete below
      // is not role-gated — so the arm that can fail is the one that PASSES a
      // path. An ops child handed a socket keeps it verbatim.
      const ops = forgeReadChildEnv(
        { ...childBase(), PI_ENSEMBLE_ROLE: "ops", [SOCKET_ENV]: "/stale/from/outer/pi-rukas.sock" },
        "ops",
        "/run/parent/ops-broker.sock",
        "/operator/config",
      );
      assert(
        ops[SOCKET_ENV] === "/run/parent/ops-broker.sock",
        `a socket the parent names reaches the child verbatim (${ops[SOCKET_ENV]})`,
      );
    },
  );
  await check(
    "forge config dirs point at real empty dirs so gh cannot fall back to the login",
    () => {
      const env = forgeReadEnv(childBase(), "explore");
      for (const k of FORGE_CONFIG_DIR_VARS) {
        const dir = env[k];
        assert(
          !!dir && existsSync(dir) && readdirSync(dir).length === 0,
          `${k} is an empty existing dir (${dir})`,
        );
      }
      assert(env.GH_CONFIG_DIR === env.GLAB_CONFIG_DIR, "one dir serves both CLIs");
    },
  );
  await check("an ops child env keeps its login verbatim (the negative arm)", () => {
    const parent: Record<string, string> = { ...childBase(), PI_ENSEMBLE_ROLE: "ops" };
    for (const t of TOKENS) parent[t] = `parent-${t}`;
    const env = forgeReadEnv(parent, "ops");
    for (const t of TOKENS) assert(env[t] === `parent-${t}`, `ops keeps ${t}`);
  });
  await check(
    "a nested child that inherits the pair cannot use it (the broker is per child)",
    () => {
      // #2160 adversarial round 1 — the decision: the broker is PER CHILD, so a
      // nested child must be neutralised by removing the pair, not by trusting an
      // inherited one. A helper that spawned a helper would otherwise hand it a
      // live credential pair it never earned, and the reads of a child the parent
      // never planned for would be answered — with this parent's forge login.
      // `childBaseEnv` (spawn-child-env.ts -> child-forge-env.ts) is the ONE
      // builder every spawn path calls, and it deletes both halves whenever this
      // dispatch has no broker of its own to name. Asserting on the builder is
      // asserting on the spawn path, because that is the spawn path's code.
      const inherited = {
        ...childBase(),
        [SOCKET_ENV]: "/parent/bound/by/another/child.sock",
        [SECRET_ENV]: newForgeReadSecret(),
      };
      const env = forgeReadChildEnv(inherited, "developer");
      assert(
        !(SOCKET_ENV in env),
        `no broker path survives into a child this parent serves nothing (${env[SOCKET_ENV]})`,
      );
      assert(
        !(SECRET_ENV in env),
        `and neither does its key (${env[SECRET_ENV]})`,
      );
      // The arm that keeps the pair: a child the parent DID bind for gets both,
      // so the delete above is a decision about the brokerless case and not a
      // blanket wipe that would also break the honest one.
      const served = forgeReadChildEnv(childBase(), "developer", "/run/parent/broker.sock");
      assert(
        served[SOCKET_ENV] === "/run/parent/broker.sock" && /^[0-9a-f]{64}$/.test(served[SECRET_ENV] ?? ""),
        `a served child carries the whole pair (${JSON.stringify(Object.keys(served))})`,
      );
    },
  );
  await check("the secret that reaches a child is a fresh 32-byte key, never an inherited one", () => {
    // A key copied from the environment would be one key shared by every child
    // of a parent (and by a reattach), which is the property the per-child secret
    // exists to remove.
    const leaked = "f".repeat(64);
    const a = forgeReadChildEnv({ ...childBase(), [SECRET_ENV]: leaked }, "developer", "/p/a.sock");
    const b = forgeReadChildEnv({ ...childBase(), [SECRET_ENV]: leaked }, "developer", "/p/b.sock");
    assert(a[SECRET_ENV] !== leaked, "the inherited key is replaced, not passed through");
    assert(a[SECRET_ENV] !== b[SECRET_ENV], "two children of one parent get two keys");
    assert(/^[0-9a-f]{64}$/.test(a[SECRET_ENV] ?? ""), "32 random bytes, hex");
  });
  await check("the strip mutates the object it is given and reports what it took", () => {
    const target: Record<string, string | undefined> = { GH_TOKEN: "x", PATH: "/bin" };
    const removed = stripForgeCredentials(target, "developer", "/tmp/empty-dir");
    assert(!("GH_TOKEN" in target), "the token key is deleted");
    assert(removed.includes("GH_TOKEN"), `removed names are reported (${removed.join(",")})`);
    const ops: Record<string, string | undefined> = { GH_TOKEN: "x" };
    assert(stripForgeCredentials(ops, "ops", "/tmp/empty-dir").length === 0, "ops reports nothing");
    assert(ops.GH_TOKEN === "x", "ops' env is untouched by the same call");
  });

  await forgeExitCode("child forge env is stripped and the broker gate is role-correct");
}

await main();
