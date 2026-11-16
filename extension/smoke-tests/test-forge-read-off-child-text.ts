#!/usr/bin/env bun
/**
 * #2284 — the child renders the forge-off refusal as its tool text.
 *
 * The broker's named reason is only worth having if the child actually shows it.
 * `requestForgeRead` drops `output` when `ok` is false and the handler renders
 * `result.reason ?? "forge_read: refused by the parent"`, so a refusal that arrived
 * with an empty reason would read to the model as the generic string —
 * indistinguishable from a socket failure — and a child would retry a read that
 * will never be served.
 *
 * So this drives the child's REAL registered tool (`callChildTool`) against a broker
 * whose read is the production one under `PI_ENSEMBLE_FORGE=none`, and asserts the
 * rendered text is the reason and is non-empty. The wire and the proof are
 * `test-forge-read-auth.ts`'s subject; the parent's side of the same arm is
 * `test-forge-read-off.ts`.
 */

import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
} from "../src/child-forge-read-activation.ts";
import { forgeReadChildEnv } from "../src/child-forge-env.ts";
import { FORGE_READ_OFF_REASON } from "../src/forge-read-broker.ts";
import { bindForgeReadSocket } from "../src/forge-read-broker.ts";
import { pair, callChildTool, withTrace } from "./lib/forge-read-auth-fixture.ts";
import { offArmExec } from "./lib/forge-read-off-arm.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

async function main(): Promise<void> {
  console.log("what the child sees when the parent's forge is off:");
  await check("the tool text IS the reason, non-empty, and carries no bytes", async () => {
    const exec = offArmExec();
    const bound = await bindForgeReadSocket("/parent/repo", { execFn: exec.fn });
    let out: { text: string; details: unknown } | undefined;
    const lines: string[] = [];
    try {
      // The pair is handed to the child exactly as the spawn layer hands it, and
      // the role is written explicitly — registration is gated on it.
      const env = forgeReadChildEnv(
        { PATH: "/bin" },
        "developer",
        bound.socketPath,
        undefined,
        bound.secret,
      );
      assert(
        env[FORGE_READ_SOCKET_ENV] === bound.socketPath &&
          env[FORGE_READ_SECRET_ENV] === bound.secret,
        "the builder really did hand the pair over — otherwise the arm below proves nothing",
      );
      await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
        out = await withTrace(lines, () =>
          callChildTool(pair(bound.socketPath, bound.secret), { verb: "issue_view", number: 42 }),
        );
      });
    } finally {
      bound.stop();
    }
    assert(
      out?.text === FORGE_READ_OFF_REASON,
      `the model reads the named refusal (${JSON.stringify(out?.text)})`,
    );
    assert(
      typeof out?.text === "string" && out.text.length > 0,
      "and it is non-empty, so it is never the generic refused-by-the-parent string",
    );
    assert(
      out?.text !== "forge_read: refused by the parent" &&
        out?.text !== "<no forge_read registered>",
      "which is neither the fallback nor a missing tool",
    );
    assert(
      (out?.details as { ok?: boolean } | undefined)?.ok === false,
      `the details say a failure (${JSON.stringify(out?.details)})`,
    );
    assert(
      !JSON.stringify(out).includes('"number": 42'),
      "no forge bytes rode along with the refusal",
    );
    assert(
      exec.calls.length === 0,
      `and the parent issued nothing for it (${JSON.stringify(exec.calls)})`,
    );
    assert(
      !lines.some((l) => l.includes(bound.secret)),
      "and no trace line leaked the broker's key",
    );
  });
  await check("with the guard off, the same child still gets its bytes", async () => {
    // The negative arm: without it every assertion above would also pass on a
    // broker that answers nothing at all.
    const exec = offArmExec();
    const bound = await bindForgeReadSocket("/parent/repo", { execFn: exec.fn });
    let out: { text: string; details: unknown } | undefined;
    try {
      const env = forgeReadChildEnv(
        { PATH: "/bin" },
        "developer",
        bound.socketPath,
        undefined,
        bound.secret,
      );
      await withEnv(
        { PI_ENSEMBLE_FORGE: "none", PI_ENSEMBLE_FORGE_READ_OFF_GUARD: "0" },
        async () => {
          out = await callChildTool(pair(bound.socketPath, bound.secret), {
            verb: "issue_view",
            number: 42,
          });
        },
      );
    } finally {
      bound.stop();
    }
    assert(
      out?.text.includes('"number": 42'),
      `the escape hatch still serves the read (${JSON.stringify(out?.text)?.slice(0, 60)})`,
    );
    assert(
      exec.calls.some((c) => c.startsWith("gh ")),
      `and the parent ran its CLI (${JSON.stringify(exec.calls)})`,
    );
  });

  await forgeExitCode("the child renders the forge-off refusal as its tool text");
}

await main();
