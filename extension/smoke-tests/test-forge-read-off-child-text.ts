/**
 * test-forge-read-off-child-text — what the CHILD actually sees when the parent's
 * forge is off.
 *
 * `test-forge-read-off.ts` proves the parent-side contract (zero commands, the
 * reason on the wire, the trace line). This case closes the one gap that leaves
 * open: the child's tool RESULT, which is the text the model reads. A broker can
 * answer correctly and the tool can still hand the model a bare "refused" with no
 * reason — which is the difference between a helper that stops and files the
 * finding, and one that retries the same read forever.
 *
 * Two arms:
 *   1. `PI_ENSEMBLE_FORGE=none`, guard default-on — the tool's text is exactly the
 *      reason, non-empty, and its details carry no bytes.
 *   2. the same env with `PI_ENSEMBLE_FORGE_READ_OFF_GUARD=0` — the tool returns
 *      the forge's bytes. Without this arm, arm 1 would also pass on a broker that
 *      answers nothing at all, or on a child whose tool never registered.
 *
 * The child's tool is driven through `registerChildForgeReadTool` on a fake API
 * object rather than through `lib/forge-read-auth-fixture.ts`'s `callChildTool`:
 * importing that module reaches its `pair`, which asserts `childEnv`'s
 * `string | undefined` values are `string`, and that widening has never been
 * type-checked under this project's smoke-tests config. The activation module
 * registers the tool against the same `ExtensionAPI` shape the fixture builds, so
 * the handler driven here is the one the model would call.
 *
 * What this case does NOT prove: that a real child process registered the tool —
 * a live spawn does that. It proves the answer the registered tool hands back.
 */

import {
  FORGE_READ_SECRET_ENV,
  FORGE_READ_SOCKET_ENV,
  registerChildForgeReadTool,
} from "../src/child-forge-read-activation.ts";
import { bindForgeReadSocket } from "../src/forge-read-broker.ts";
import { FORGE_READ_OFF_REASON } from "../src/forge-read-off-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";
import { childPair } from "./lib/forge-read-child-pair.ts";
import { offArmExec } from "./lib/forge-read-off-arm.ts";

/** The shape the fake API collects, so the driver can find the tool by name. */
interface Registered {
  name: string;
  execute: (
    id: string,
    raw: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
}

/**
 * Drive the child's registered `forge_read` once, with `env` as the process env.
 *
 * Registration and the request both read the pair and the role out of
 * `process.env`, so the env is installed for the duration of the call and
 * restored after it — the broker's per-connection nonce, secret and origin proof
 * are all satisfied by `bindForgeReadSocket` + `childPair`, so the ONLY reason
 * this call would fail is the one under test.
 *
 * It ADDS the pair and the role rather than clearing the environment first: the
 * parent's broker decides the arm in ITS socket handler, which the event loop runs
 * after the child's write returns, so a driver that wiped `process.env` would have
 * the parent find `PI_ENSEMBLE_FORGE` gone and serve the read while the case
 * believed it had pinned `none`. Each arm's own `withEnv` owns the switch for the
 * whole round-trip; this only overlays the child's own variables and puts back what
 * it changed.
 */
async function callChildToolOnce(
  env: Record<string, string>,
  args: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const keys = Object.keys(env);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const registered: Registered[] = [];
  // Shaped structurally: the activation module calls `pi.registerTool({ name,
  // execute, … })` with ONE object, so this collects that object and the rest of
  // Pi's `ExtensionAPI` surface stays unnamed (this project's smoke-tests config
  // pins `"types": ["node"]` and has never resolved the Pi packages).
  const fakeApi = {
    registerTool: (config: { name: string; execute: Registered["execute"] }): void => {
      registered.push({ name: config.name, execute: config.execute });
    },
  } as never;
  try {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    // `void` on purpose: registration is a side effect, and "did it register" is
    // answered by what the fake collected, not by a return value the function
    // does not have. A role the predicate refuses leaves the list empty.
    registerChildForgeReadTool(fakeApi);
    const tool = registered.find((r) => r.name === "forge_read");
    if (!tool) throw new Error("forge_read was not registered under its own name");
    const res = await tool.execute("off-arm-1", args);
    return { text: res.content.map((c) => c.text).join(""), details: res.details };
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

/**
 * Capture what the parent's broker writes to stderr while `fn` runs.
 *
 * The off-arm decision traces the reason (the child's trace sink does not reach
 * the parent's stderr, so this asserts the operator-visible half, not the child's).
 * Restoring `process.stderr.write` in the same `finally` that ends the capture is
 * what keeps a red case from leaving the suite's stderr hijacked for the files
 * that run after it.
 */
async function withCapturedStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const savedWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = savedWrite;
  }
  return lines;
}

const REQUEST = { verb: "issue_view" as const, number: 42 };

async function main(): Promise<void> {
  console.log("what the child sees when the parent's forge is off:");

  await check("the tool text IS the reason, non-empty, and carries no bytes", async () => {
    const exec = offArmExec();
    const bound = await bindForgeReadSocket("/parent/repo", { execFn: exec.fn });
    let out: { text: string; details: unknown } | undefined;
    let lines: string[] = [];
    try {
      const env = childPair(bound.socketPath, bound.secret);
      // The pair is handed to the child exactly as the spawn layer hands it, and
      // the role is written explicitly — registration is gated on it.
      assert(
        env[FORGE_READ_SOCKET_ENV] === bound.socketPath &&
          env[FORGE_READ_SECRET_ENV] === bound.secret,
        "the builder really did hand the pair over — otherwise the arm below proves nothing",
      );
      await withEnv({ PI_ENSEMBLE_FORGE: "none" }, async () => {
        lines = await withCapturedStderr(async () => {
          out = await callChildToolOnce(env, REQUEST);
        });
      });
    } finally {
      bound.stop();
    }
    assert(
      out?.text === FORGE_READ_OFF_REASON,
      `the model reads the named refusal (${JSON.stringify(out?.text)})`,
    );
    const text: string = out?.text ?? "";
    assert(text.length > 0, "and the text is non-empty");
    assert(
      text !== "forge_read: refused by the parent" && text !== "<no forge_read registered>",
      "which is neither the generic fallback nor a missing tool",
    );
    assert(
      (out?.details as { ok?: boolean } | undefined)?.ok === false,
      `the details say so too (${JSON.stringify(out?.details)?.slice(0, 80)})`,
    );
    assert(
      !JSON.stringify(out?.details ?? {}).includes('"body"'),
      "and the details carry no bytes",
    );
    assert(
      lines.some((l) => l.includes(FORGE_READ_OFF_REASON)),
      `the parent traced the reason for the operator (${JSON.stringify(lines).slice(0, 160)})`,
    );
    assert(
      !lines.some((l) => l.includes(bound.secret)),
      "and the trace did not leak the child's key",
    );
    assert(exec.calls.length === 0, `the parent ran nothing (${JSON.stringify(exec.calls)})`);
  });

  await check("with the guard off, the same child still gets its bytes", async () => {
    // The negative arm, and the reason this file exists beside the parent-side
    // one: arm 1 above is what a broker that answers nothing produces too.
    const exec = offArmExec();
    const bound = await bindForgeReadSocket("/parent/repo", { execFn: exec.fn });
    let out: { text: string; details: unknown } | undefined;
    try {
      await withEnv(
        { PI_ENSEMBLE_FORGE: "none", PI_ENSEMBLE_FORGE_READ_OFF_GUARD: "0" },
        async () => {
          out = await callChildToolOnce(childPair(bound.socketPath, bound.secret), REQUEST);
        },
      );
    } finally {
      bound.stop();
    }
    assert(
      out?.text.includes('"number": 42') === true,
      `the escape hatch still serves the read (${JSON.stringify(out?.text)?.slice(0, 60)})`,
    );
    assert(
      exec.calls.some((c) => c.startsWith("gh ")),
      `and the parent ran its CLI (${JSON.stringify(exec.calls)})`,
    );
  });

  await forgeExitCode("the child renders the forge-off refusal as its tool text");
}

main();
