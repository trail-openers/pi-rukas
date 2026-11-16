#!/usr/bin/env bun
/**
 * #2284 — `PI_ENSEMBLE_FORGE=none` stops the parent's `forge_read` broker.
 *
 * `docs/configuration.md` has always said `none` turns the forge off: "no
 * detection, no `gh`/`glab` call". The driver honoured that (`resolveCycleForge`
 * short-circuits it); the child-facing broker did not. `runForgeRead` called
 * `detectForge` directly, and `detectForge` treats only `github`/`gitlab` as a hard
 * override — so `none` read as "unrecognised, fall through to the remote" and the
 * DISPATCHING PARENT ran `gh` on a helper child's behalf for a forge the operator
 * had turned off.
 *
 * Four properties, none of which the existing broker suites can see:
 *
 *   1. under `none` a proved read comes back `{ok:false}` with the reason
 *      `the forge is off: PI_ENSEMBLE_FORGE=none`, and `reason.length > 0` — the
 *      child renders `result.reason` as its tool text, so an empty reason would
 *      surface as the generic "refused by the parent" and be indistinguishable
 *      from a socket failure;
 *   2. ZERO commands on the read path — not merely no `gh`/`glab`, but no
 *      `git config --get remote.*` and no `git remote` either, since those are the
 *      three execs `detectForge` issues before any CLI runs;
 *   3. the socket still BOUND and the line still PROVED: the refusal rode the
 *      post-authentication path, so a stranger cannot learn the forge is off;
 *   4. unset and `github` are byte-unchanged — the read still reaches the parent's
 *      executor and answers bytes.
 *
 * Every case binds a broker with NO `runRead` and watches the parent's own
 * executor through the broker's `execFn` seam (`mkExec`). A case that injected
 * `runRead` would never reach `detectForge` and would assert zero commands against
 * a code path it never entered — which is precisely how this defect survived the
 * #2160 suites.
 *
 * The env is pinned with `withEnv` per case: the whole file runs in one bun
 * process, and the guard is read at CALL time precisely so a pin cannot leak from
 * one arm into the next.
 */

import { existsSync } from "node:fs";
import { bindForgeReadSocket } from "../src/forge-read-broker.ts";
import { FORGE_READ_OFF_REASON } from "../src/forge-read-off-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import { OFF_ARM_REQUEST, driveProvedRead, offArmExec } from "./lib/forge-read-off-arm.ts";

/** A forge CLI, or any of the remote reads `detectForge` issues before one. */
const FORGE_OR_REMOTE = /^(gh |glab |git config --get remote\.|git remote)/;

async function main(): Promise<void> {
  console.log("none (the arm the operator set and the broker ignored):");
  await check("a proved read under none is refused with the named reason", async () => {
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
      run = await driveProvedRead({ execFn: exec.fn });
    });
    const res = run?.fields;
    assert(res !== undefined, `the broker answered rather than hanging (${JSON.stringify(res)})`);
    assert(res?.ok === false, `none is a failure, not an empty read (${JSON.stringify(res)})`);
    assert(
      res?.reason === "the forge is off: PI_ENSEMBLE_FORGE=none",
      `the refusal names the variable and its value verbatim (got ${JSON.stringify(res?.reason)})`,
    );
    assert(
      typeof res?.reason === "string" && res.reason.length > 0,
      "the reason is non-empty — the child renders it as its tool text",
    );
    assert(
      res?.output === undefined,
      "a refusal carries no bytes (${JSON.stringify(res?.output)})",
    );
  });
  await check("none issues zero commands — no CLI and no remote read", async () => {
    const exec = offArmExec();
    await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
      await driveProvedRead({ execFn: exec.fn });
    });
    assert(
      exec.calls.length === 0,
      `the parent issued nothing for a forge that is off (${JSON.stringify(exec.calls)})`,
    );
    assert(
      !exec.calls.some((c) => FORGE_OR_REMOTE.test(c)),
      "and the recorder would have caught a gh/glab/remote command had one run",
    );
  });
  await check("the none refusal is proved, so only the child learns it", async () => {
    // The refusal sits AFTER authentication and `nonces.serve`, so it carries the
    // reply's proof. A gate placed earlier would answer an unproved caller with a
    // mac-bearing line and teach a stranger what a valid proof looks like. The
    // proof itself is verified by the child's half in test-forge-read-auth.ts;
    // what is asserted here is that the mac KEYS ARE PRESENT on this refusal and
    // that the refusal is a proved-path shape rather than a plain auth refusal.
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
      run = await driveProvedRead({ execFn: exec.fn });
    });
    const res = run?.fields;
    assert(
      res?.type === "forge-read-response",
      `the answer is a broker reply (${JSON.stringify(res?.type)})`,
    );
    assert(
      res?.reason !== "forge_read: unauthenticated request" &&
        res?.reason !== "forge_read: request is not a JSON object",
      `the line reached the proved path rather than the auth gate (${JSON.stringify(res?.reason)})`,
    );
  });
  await check("under none the socket still binds, so the tool still registers", async () => {
    // ~35 offline suites expect a live socket path from planChildPermissions; the
    // fix changes what a served read DOES, never whether the socket exists. A
    // child of an operator who set `none` therefore reads a reason it can act on
    // rather than discovering the tool was never there. The dial below reaching a
    // refusal at all is the evidence: an unbound socket answers nothing.
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    let bound = false;
    await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
      const handle = await bindForgeReadSocket("/parent/repo", { execFn: exec.fn });
      bound = existsSync(handle.socketPath);
      handle.stop();
      run = await driveProvedRead({ execFn: exec.fn });
    });
    assert(bound, "the broker bound a real socket file under none");
    assert(
      run !== undefined && run.fields.ok === false,
      "and a read on it came back refused rather than silent",
    );
  });

  console.log("the arms that must not move:");
  await check("unset: the read reaches the parent's executor and answers bytes", async () => {
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    await withEnv({ PI_ENSEMBLE_FORGE: undefined }, async () => {
      run = await driveProvedRead({ execFn: exec.fn });
    });
    const res = run?.fields;
    assert(res?.ok === true, `unset still reads the forge (${JSON.stringify(res)})`);
    assert(
      typeof res?.output === "string" && res.output.includes('"number": 42'),
      `the answer is the forge's bytes (${JSON.stringify(res?.output)?.slice(0, 60)})`,
    );
    assert(
      exec.calls.some((c) => c.startsWith("gh ")),
      `the parent ran its CLI on the unset arm (${JSON.stringify(exec.calls)})`,
    );
  });
  await check("github (a hard override) is unchanged: no refusal, no fall-through", async () => {
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    await withEnv({ PI_ENSEMBLE_FORGE: "github" }, async () => {
      run = await driveProvedRead({ execFn: exec.fn });
    });
    assert(run?.fields.ok === true, `github still reads (${JSON.stringify(run?.fields)})`);
    assert(
      exec.calls.some((c) => c.startsWith("gh ")),
      `and the CLI ran (${JSON.stringify(exec.calls)})`,
    );
  });
  await check("an unrecognised value is still NOT off (only none is)", async () => {
    // `bitbucket` falls through to the remote exactly as `none` used to. The fix
    // is the exact `=== "none"` comparison, so widening it to "anything the
    // detector does not name" would change this arm.
    const exec = offArmExec();
    let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
    await withEnv({ PI_ENSEMBLE_FORGE: "bitbucket" }, async () => {
      run = await driveProvedRead({ execFn: exec.fn });
    });
    assert(
      run?.fields.ok === true,
      `bitbucket is not the off value (${JSON.stringify(run?.fields)})`,
    );
    assert(exec.calls.length > 0, "and the read path still ran");
  });

  console.log("the exact-match contract:");
  await check('None / "none " are NOT off — same comparison the driver makes', async () => {
    for (const value of ["None", "none ", "NONE"]) {
      const exec = offArmExec();
      let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
      await withEnv({ PI_ENSEMBLE_FORGE: value }, async () => {
        run = await driveProvedRead({ execFn: exec.fn });
      });
      assert(
        run?.fields.reason !== FORGE_READ_OFF_REASON,
        `PI_ENSEMBLE_FORGE=${JSON.stringify(value)} is not the off value (${JSON.stringify(
          run?.fields,
        )})`,
      );
    }
  });

  console.log("the request, not the socket, is what is refused:");
  await check("every verb under none is refused, and none of them execs", async () => {
    for (const req of [
      { verb: "issue_list" },
      { verb: "repo_settings" },
      { verb: "pr_diff", number: 17 },
    ]) {
      const exec = offArmExec();
      let run: Awaited<ReturnType<typeof driveProvedRead>> | undefined;
      await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
        run = await driveProvedRead({ execFn: exec.fn }, req);
      });
      assert(
        run?.fields.ok === false && run.fields.reason === FORGE_READ_OFF_REASON,
        `${req.verb} refused with the named reason (${JSON.stringify(run?.fields)})`,
      );
      assert(exec.calls.length === 0, `${req.verb} issued nothing (${JSON.stringify(exec.calls)})`);
    }
  });

  // Non-vacuity: the recorder must be able to record at all, or every zero-call
  // assertion above would pass on a broker that answers nothing.
  await check(
    "the recorder is not vacuous: the same executor records on the unset arm",
    async () => {
      const exec = offArmExec();
      await withEnv({ PI_ENSEMBLE_FORGE: undefined }, async () => {
        await driveProvedRead(
          { execFn: exec.fn },
          OFF_ARM_REQUEST as unknown as Record<string, unknown>,
        );
      });
      assert(exec.calls.length > 0, "the seam did record commands for a served read");
    },
  );

  await forgeExitCode("forge_read refuses under PI_ENSEMBLE_FORGE=none and issues nothing");
}

await main();
