#!/usr/bin/env bun
/**
 * #2160 adversarial round 1, half B — what a child is HANDED, and what a correct
 * round trip still costs.
 *
 * Half A (`test-forge-read-auth.ts`) attacks the wire. This file pins the two
 * things that make the wire usable, and the two properties the operator asked to
 * see held:
 *
 *   1. the correct broker round trip works — the negative arm; without it every
 *      refusal in half A would pass on a broker that simply answers nothing;
 *   2. half a pair is no pair: a child given the socket but not the key (or the
 *      key but not the socket) registers no tool at all, so the state "offered a
 *      tool that can only refuse" is unreachable;
 *   3. the secret appears in NO recorded output — no tool result, no tool
 *      details, no trace line from either half of the channel;
 *   4. the env construction: socket AND secret are handed over together or not at
 *      all, and an inherited pair is deleted by a parent that binds nothing —
 *      which is the nested-child rule, since a broker is per child.
 */

import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
  forgeReadAvailableForRole,
} from "../src/child-forge-read-activation.ts";
import { forgeReadChildEnv } from "../src/child-forge-env.ts";
import { FORGE_READ_SECRET_BYTES, newForgeReadSecret } from "../src/forge-read-auth.ts";
import { type RunForgeRead, bindForgeReadSocket } from "../src/forge-read-broker.ts";
import {
  askRaw,
  callChildTool,
  withTrace,
} from "./lib/forge-read-auth-fixture.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

const SOCKET_ENV = FORGE_READ_SOCKET_ENV;
const SECRET_ENV = FORGE_READ_SECRET_ENV;

async function main(): Promise<void> {
  console.log("the correct broker round trip (the arm that makes the refusals mean something):");
  await check("a child holding the pair gets the parent's bytes, authenticated", async () => {
    let seen = 0;
    let handedDown: Record<string, unknown> | undefined;
    const runRead: RunForgeRead = async (_cwd, req) => {
      seen++;
      handedDown = req as unknown as Record<string, unknown>;
      return "the parent's own forge answered";
    };
    const bound = await bindForgeReadSocket("/parent/repo", { runRead });
    try {
      // The pair is handed to the child the way the spawn layer hands it: the
      // broker's own key beside its own path, through the one env builder.
      const env = forgeReadChildEnv(
        { PATH: "/bin", PI_ENSEMBLE_ROLE: "developer" },
        "developer",
        bound.socketPath,
        undefined,
        bound.secret,
      );
      const res = await callChildTool(env, { verb: "issue_view", number: 9 });
      assert(seen === 1, "the parent ran the read once");
      // The proved request reached the executor with its verb and target intact
      // and with nothing the envelope added: the parser's field-by-field
      // whitelist is what guarantees that, so the assertion is on the KEYS the
      // executor was handed rather than on the text that came back.
      assert(
        JSON.stringify(Object.keys(handedDown ?? {}).sort()) ===
          JSON.stringify(["number", "type", "verb"]),
        `downstream carries the declared request only (${JSON.stringify(Object.keys(handedDown ?? {}))})`,
      );
      assert(
        handedDown?.verb === "issue_view" && handedDown?.number === 9,
        `the proved read survived the round trip (${JSON.stringify(handedDown)})`,
      );
      assert(
        res.text === "the parent's own forge answered",
        `bytes came through (${JSON.stringify(res.text)})`,
      );
      assert((res.details as { ok?: boolean })?.ok === true, "the result reports success");
    } finally {
      bound.stop();
    }
  });

  console.log("half a pair is no pair:");
  await check("a child with the socket but no key registers no tool at all", async () => {
    const bound = await bindForgeReadSocket("/parent/repo", {
      runRead: async () => "should never run",
    });
    try {
      const onlySocket = await callChildTool(
        { [SOCKET_ENV]: bound.socketPath, PI_ENSEMBLE_ROLE: "developer" },
        { verb: "pr_view", number: 1 },
      );
      assert(
        /no forge_read registered/.test(onlySocket.text),
        `a socket alone registers nothing (${onlySocket.text})`,
      );
      const onlySecret = await callChildTool(
        { [SECRET_ENV]: bound.secret, PI_ENSEMBLE_ROLE: "developer" },
        { verb: "pr_view", number: 1 },
      );
      assert(/no forge_read registered/.test(onlySecret.text), "a key alone registers nothing");
      assert(
        forgeReadAvailableForRole("developer") === false,
        "the predicate refuses a child with neither variable set",
      );
    } finally {
      bound.stop();
    }
  });

  console.log("the secret in recorded output:");
  await check("no child-side refusal, result or trace line carries the secret", async () => {
    // The listener answers with a reply the child cannot verify, so the REFUSAL
    // text is the string this child writes while holding a live key — the one
    // place a child-side leak could come from.
    const SECRET = newForgeReadSecret();
    const { startForeign } = await import("./lib/forge-read-auth-fixture.ts");
    const foreign = await startForeign((line: string) => ({
      type: "forge-read-response",
      ok: false,
      reason: "nope",
      nonce: "listener-nonce",
      echo: (JSON.parse(line) as { nonce?: string }).nonce,
    }));
    const lines: string[] = [];
    try {
      const res = await withTrace(lines, () =>
        callChildTool(
          {
            [SOCKET_ENV]: foreign.socketPath,
            [SECRET_ENV]: SECRET,
            PI_ENSEMBLE_ROLE: "developer",
          },
          { verb: "issue_view", number: 1 },
        ),
      );
      const recorded = [res.text, JSON.stringify(res.details), ...lines].join("\n");
      assert(!recorded.includes(SECRET), "the refusal never carries the secret");
      assert(
        !/PI_ENSEMBLE_FORGE_READ_SECRET/.test(recorded),
        "nor names the variable it came from",
      );
    } finally {
      foreign.stop();
    }
  });
  await check("no broker trace line carries the secret", async () => {
    const SECRET = newForgeReadSecret();
    const lines: string[] = [];
    await withTrace(lines, async () => {
      const b = await bindForgeReadSocket("/parent/repo", {
        runRead: async () => "ok",
        secret: SECRET,
      });
      // One unproved request and one bind/stop cycle: the two lines the broker
      // writes on a normal serve, which is where a key would surface if it were
      // ever interpolated into a message.
      await askRaw(
        b.socketPath,
        `${JSON.stringify({ type: "forge-read-request", verb: "repo_settings" })}\n`,
      );
      b.stop();
    });
    const recorded = lines.join("\n");
    assert(
      !recorded.includes(SECRET),
      `the broker's trace lines never print the secret (${recorded.slice(0, 200)})`,
    );
    assert(recorded.length > 0, "non-vacuity: trace lines were captured to check");
  });

  console.log("the env construction hands the pair over together:");
  await check("a stripped child gets socket and secret together", () => {
    const env = forgeReadChildEnv(
      { PATH: "/bin" },
      "developer",
      "/run/parent/broker.sock",
      undefined,
    );
    assert(env[SOCKET_ENV] === "/run/parent/broker.sock", "the socket is named");
    assert(
      typeof env[SECRET_ENV] === "string" &&
        new RegExp(`^[0-9a-f]{${FORGE_READ_SECRET_BYTES * 2}}$`).test(env[SECRET_ENV] ?? ""),
      `the secret is a ${FORGE_READ_SECRET_BYTES}-byte hex key`,
    );
  });
  await check("no socket means no secret — an inherited pair is deleted", () => {
    // The reattach path and any bind failure, and the nested-child case the
    // operator's step 5 asks about: a broker is PER CHILD, so a child whose own
    // parent bound nothing must hold neither half of a pair it inherited.
    const stale = forgeReadChildEnv(
      { PATH: "/bin", [SOCKET_ENV]: "/stale/broker.sock", [SECRET_ENV]: newForgeReadSecret() },
      "developer",
    );
    assert(!(SOCKET_ENV in stale), "no inherited socket survives");
    assert(!(SECRET_ENV in stale), `no inherited secret survives (${stale[SECRET_ENV]})`);
  });
  await check("two children of one parent never share a key", () => {
    // One key for a parallel batch would let either child answer the other's
    // reads as if it were the parent — the same takeover, one layer in.
    const leaked = "f".repeat(64);
    const a = forgeReadChildEnv(
      { [SECRET_ENV]: leaked },
      "developer",
      "/p/a.sock",
      undefined,
    );
    const b = forgeReadChildEnv({ [SECRET_ENV]: leaked }, "developer", "/p/b.sock");
    assert(a[SECRET_ENV] !== leaked, "an inherited key is replaced, not passed through");
    assert(a[SECRET_ENV] !== b[SECRET_ENV], "two children of one parent get two keys");
  });
  await check("ops is handed neither half (it holds its own login)", () => {
    const env = forgeReadChildEnv(
      { PATH: "/bin", PI_ENSEMBLE_ROLE: "ops" },
      "ops",
      undefined,
      "/operator/config",
    );
    assert(!(SOCKET_ENV in env) && !(SECRET_ENV in env), "ops carries no broker pair");
  });

  await forgeExitCode("forge_read hands the pair over together and keeps the key out of output");
}

await main();
