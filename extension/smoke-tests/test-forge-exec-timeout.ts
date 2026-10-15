/**
 * test-forge-exec-timeout.ts — #1261: forge exec calls have a default timeout.
 *
 * A `gh` call on a half-open connection or a stalled proxy hangs forever.
 * The entry gate (`checkAttentionLabel`) and the handoff path
 * (`verifyHandoffLabel`, `postHandoffWithRetry`) each call forge operations
 * that go through `createForge`'s `run` helper. Without a timeout, those
 * calls never settle: no event persisted, no terminal status, and a
 * re-entry could double-post the handoff comment.
 *
 * This test injects a forge over an `execFn` that honours the `timeout`
 * option (rejecting with a timeout error when the deadline passes, the
 * same shape node's `exec` produces). It asserts that:
 *
 *   1. The `timeout` option is passed to the `execFn` on every forge call.
 *   2. A hanging forge call settles (rejects) within the bound.
 *   3. `checkAttentionLabel` settles within the bound.
 *   4. `verifyHandoffLabel` settles within the bound.
 *   5. `postHandoffWithRetry` settles within the bound.
 *   6. A caller-supplied `execOpts.timeout` overrides the default.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-exec-timeout.ts
 */

import { createForge, type ForgeExecFn } from "../src/forge.ts";
import { ghDetection } from "./forge-fixtures.ts";
import { checkAttentionLabel } from "../src/work-driver-attention.ts";
import { verifyHandoffLabel } from "../src/work-driver-handoff-post.ts";
import { postHandoffWithRetry } from "../src/work-driver-handoff-post-retry.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/**
 * An execFn that records calls and, when `hang` is set, honours the
 * `timeout` option by rejecting after `timeout` ms (simulating what
 * node's `exec` does on a stalled child process). When `hang` is false,
 * it resolves immediately with the provided stdout.
 */
function mkHangingExec(opts: { hang: boolean; stdout?: string } = { hang: false }) {
  const calls: Array<{ cmd: string; timeout?: number }> = [];
  const fn: ForgeExecFn = (cmd, o) => {
    calls.push({ cmd, timeout: o?.timeout });
    if (opts.hang) {
      // Simulate node's exec timeout: reject after `timeout` ms.
      const ms = o?.timeout ?? 0;
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          const err = new Error(`command timed out after ${ms}ms: ${cmd}`) as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = "SIGKILL";
          reject(err);
        }, ms);
      });
    }
    return Promise.resolve({ stdout: opts.stdout ?? "" });
  };
  return { fn, calls };
}

async function main() {
  const det = ghDetection("acme", "widget");

  // ── 1. The `timeout` option is passed to the execFn on every forge call ──

  const issueJson = JSON.stringify({
    number: 42,
    title: "test",
    body: "body",
    state: "OPEN",
    url: "https://github.com/acme/widget/issues/42",
    labels: [],
  });

  console.log("timeout propagation:");
  await check("createForge passes a default timeout to execFn", async () => {
    const { fn, calls } = mkHangingExec({ hang: false, stdout: issueJson });
    const forge = createForge(det, { execFn: fn });
    await forge.issueView(42);
    assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
    assert(
      calls[0].timeout === 60_000,
      `expected default timeout 60_000, got ${calls[0].timeout}`,
    );
  });

  await check("caller-supplied execOpts.timeout overrides the default", async () => {
    const { fn, calls } = mkHangingExec({ hang: false, stdout: issueJson });
    const forge = createForge(det, { execFn: fn, execOpts: { timeout: 45_000 } });
    await forge.issueView(42);
    assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
    assert(calls[0].timeout === 45_000, `expected 45_000, got ${calls[0].timeout}`);
  });

  await check("every forge operation carries the default timeout", async () => {
    const { fn, calls } = mkHangingExec({ hang: false, stdout: issueJson });
    const forge = createForge(det, { execFn: fn });
    await forge.issueView(42);
    await forge.labelAdd("issue", 42, "bug");
    assert(calls.length >= 2, `expected >=2 calls, got ${calls.length}`);
    for (const c of calls) {
      assert(c.timeout === 60_000, `expected 60_000 on "${c.cmd}", got ${c.timeout}`);
    }
  });

  // ── 2. A hanging forge call settles (rejects) within the bound ──────────

  console.log("hanging exec settles:");
  await check("issueView on a hanging execFn rejects within the timeout", async () => {
    const { fn } = mkHangingExec({ hang: true });
    const forge = createForge(det, { execFn: fn, execOpts: { timeout: 50 } });
    const start = Date.now();
    let rejected = false;
    try {
      await forge.issueView(42);
    } catch {
      rejected = true;
    }
    const elapsed = Date.now() - start;
    assert(rejected, "expected the call to reject");
    assert(elapsed < 5_000, `expected to settle quickly, took ${elapsed}ms`);
  });

  // ── 3. checkAttentionLabel settles within the bound ──────────────────────

  console.log("checkAttentionLabel:");
  await check("checkAttentionLabel settles when forge exec hangs", async () => {
    const { fn } = mkHangingExec({ hang: true });
    const forge = createForge(det, { execFn: fn, execOpts: { timeout: 50 } });
    const start = Date.now();
    const verdict = await checkAttentionLabel("/tmp", 42, { forge });
    const elapsed = Date.now() - start;
    assert(elapsed < 5_000, `expected to settle quickly, took ${elapsed}ms`);
    // The forge call throws (timeout), so checkAttentionLabel catches it
    // and returns checked: false (unreadable result does not refuse).
    assert(verdict.refuse === false, "should not refuse on timeout");
    assert(verdict.checked === false, "should report checked: false on unreadable");
  });

  // ── 4. verifyHandoffLabel settles within the bound ───────────────────────

  console.log("verifyHandoffLabel:");
  await check("verifyHandoffLabel settles when forge exec hangs", async () => {
    const { fn } = mkHangingExec({ hang: true });
    const forge = createForge(det, { execFn: fn, execOpts: { timeout: 50 } });
    const start = Date.now();
    const verified = await verifyHandoffLabel(forge, "issue", 42);
    const elapsed = Date.now() - start;
    assert(elapsed < 5_000, `expected to settle quickly, took ${elapsed}ms`);
    // The forge call throws, so verifyHandoffLabel catches it and returns false.
    assert(verified === false, "should return false on timeout");
  });

  // ── 5. postHandoffWithRetry settles within the bound ─────────────────────

  console.log("postHandoffWithRetry:");
  await check("postHandoffWithRetry settles when forge exec hangs", async () => {
    const { fn } = mkHangingExec({ hang: true });
    const forge = createForge(det, { execFn: fn, execOpts: { timeout: 50 } });
    const start = Date.now();
    const result = await postHandoffWithRetry(forge, {
      issue: 42,
      body: "handoff body",
      expectedBody: "handoff body",
      targetId: 42,
      objType: "issue",
      needsComment: true,
      needsLabel: true,
      sleep: async () => {},
    });
    const elapsed = Date.now() - start;
    assert(elapsed < 30_000, `expected to settle within 30s, took ${elapsed}ms`);
    // All attempts fail (timeout), so the result has no commentUrl and no label.
    assert(result.commentUrl === undefined, "should not have a comment URL");
    assert(result.labelApplied === false, "should not have the label applied");
  });

  // ── 6. The default timeout constant is 60 s ─────────────────────────────

  console.log("default constant:");
  await check("the default forge exec timeout is 60 s", async () => {
    const { fn, calls } = mkHangingExec({ hang: false, stdout: issueJson });
    const forge = createForge(det, { execFn: fn });
    await forge.issueView(42);
    assert(calls.length >= 1, "expected at least one call");
    assert(calls[0].timeout === 60_000, `expected 60_000, got ${calls[0].timeout}`);
  });
}

main().then(() => process.exit(exitCode));
