#!/usr/bin/env bun
/**
 * #1025 — who is allowed to speak for the merge-authority judge.
 *
 * `mergeAuthorityJudge` is the gate that decides whether an injected
 * `policyJudgeFn` answers the merge-authority question or gets ignored in favour
 * of the real `judgePolicy` child. `test-headless-evidence-gate.ts` case 5
 * drives it through the whole headless composition, which is why it cannot
 * detect the gate being deleted: that case also sets
 * `PI_ENSEMBLE_POLICY_JUDGE=0`, so `askPolicy` denies at its first line and
 * never consults either judge. Deleting `injectedJudgeAllowed` outright — the
 * exact regression the gate exists to stop — leaves that case green.
 *
 * So this file asserts the seam directly: which function comes back, and what
 * the trace says about it. The two questions are independent, and both are
 * load-bearing. A caller of `runHeadless` on a host that never set
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN` must get the REAL judge and see a warning that
 * its seam was ignored; the offline harness must get its injected judge and see
 * the warning that says so. Neither warning is gated on `PI_ENSEMBLE_DEBUG`
 * (`traceWarn` writes unconditionally), so the capture below is a real signal,
 * not a debug-mode artefact that passes on an empty capture.
 */

import type { CycleContext } from "../src/work-driver-context.ts";
import { mergeAuthorityJudge } from "../src/work-driver-judge-seam.ts";
import type { PolicyJudgeFn } from "../src/work-driver-policy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const ENV_KEY = "PI_ENSEMBLE_FORBID_LIVE_SPAWN";
const saved = process.env[ENV_KEY];

/** A minimal context carrying only what the seam reads. */
function ctxWith(injected?: PolicyJudgeFn): CycleContext {
  return {
    host: { sendUserMessage: () => undefined, emit: () => undefined },
    repoRoot: "/tmp/judge-seam",
    issue: 1025,
    emitSink: { emit: () => undefined, fingerprints: [] },
    ...(injected ? { policyJudgeFn: injected } : {}),
  } as unknown as CycleContext;
}

/** Run `fn` with the env key in one exact state, capturing everything stderr saw. */
async function withEnv(
  value: string | undefined,
  fn: () => Promise<{ result: PolicyJudgeFn; stderr: string[] }>,
): Promise<{ result: PolicyJudgeFn; stderr: string[] }> {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  const stderr: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = real;
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

const injected: PolicyJudgeFn = async () => ({ toolUses: [{ name: "injected" }] });
let built = 0;
const build = (): PolicyJudgeFn => {
  built++;
  return async () => ({ toolUses: [{ name: "built" }] });
};

// ── 1. No ban set (the host shape): the injected judge is IGNORED, the real one built.
{
  built = 0;
  const { result, stderr } = await withEnv(undefined, () =>
    mergeAuthorityJudgePromise(ctxWith(injected), build),
  );
  assert(built === 1, "with no PI_ENSEMBLE_FORBID_LIVE_SPAWN, the real judge was BUILT");
  assert(result !== injected, "...and the returned judge is NOT the injected function");
  assert(
    stderr.some((s) => s.includes("injected policy judge was ignored")),
    `the trace says the injected judge was ignored (${stderr.length} stderr line(s) captured)`,
  );
  assert(
    stderr.some((s) => s.includes("PI_ENSEMBLE_FORBID_LIVE_SPAWN=1")),
    "the warning names the switch an operator would have to set for the seam to speak",
  );
  assert(
    !stderr.some((s) => s.includes("INJECTED judge")),
    "and the harness warning does NOT fire — this is not a test harness",
  );
}

// ── 2. Ban set to a truthy-looking-but-not-"1" value: still the real judge.
// The gate is `=== "1"`, not truthiness. A host that wrote `=true` did NOT
// declare itself the offline suite, and an injected voice must not speak.
{
  built = 0;
  const { result, stderr } = await withEnv("true", () =>
    mergeAuthorityJudgePromise(ctxWith(injected), build),
  );
  assert(
    built === 1,
    'FORBID_LIVE_SPAWN="true" is not the offline marker — the real judge was BUILT',
  );
  assert(result !== injected, "...and the injected function was still not handed back");
  assert(
    stderr.some((s) => s.includes("injected policy judge was ignored")),
    'the ignored-warning still fires for a non-"1" value',
  );
}

// ── 3. Ban explicitly "0": still the real judge.
{
  built = 0;
  const { result, stderr } = await withEnv("0", () =>
    mergeAuthorityJudgePromise(ctxWith(injected), build),
  );
  assert(built === 1, 'FORBID_LIVE_SPAWN="0" builds the real judge too');
  assert(result !== injected, "and the injected seam stays silent");
  assert(
    stderr.some((s) => s.includes("injected policy judge was ignored")),
    "with the ignored-warning on the trace",
  );
}

// ── 4. Ban "1" (the offline suite's own setting): the injected judge speaks.
{
  built = 0;
  const { result, stderr } = await withEnv("1", () =>
    mergeAuthorityJudgePromise(ctxWith(injected), build),
  );
  assert(result === injected, 'FORBID_LIVE_SPAWN="1" returns the INJECTED judge itself');
  assert(built === 0, "...and the real judge is never built, so an offline case never forks");
  assert(
    stderr.some((s) => s.includes("INJECTED judge")),
    `the trace says authority is being judged by an injected judge (${stderr.length} line(s))`,
  );
  assert(
    stderr.some((s) => s.includes("test harness")),
    "and says plainly that this is a harness, not a live cycle",
  );
  assert(
    !stderr.some((s) => s.includes("was ignored")),
    "the ignored-warning does NOT fire when the seam is honoured",
  );
}

// ── 5. No injected seam at all: the build path, with no warning either way.
// The seam must not manufacture a warning when nothing was injected — an
// operator reading the trace should see the ignored-warning only when an
// injection was actually refused.
{
  built = 0;
  const { result, stderr } = await withEnv(undefined, () =>
    mergeAuthorityJudgePromise(ctxWith(undefined), build),
  );
  assert(built === 1, "with nothing injected, the real judge is built");
  assert(result !== injected, "and it is the built function, not the test's injected one");
  assert(
    !stderr.some((s) => s.includes("injected")),
    "and no injection warning appears when nothing was injected",
  );
}

function mergeAuthorityJudgePromise(
  ctx: CycleContext,
  make: () => PolicyJudgeFn,
): Promise<{ result: PolicyJudgeFn; stderr: string[] }> {
  const stderr: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return Promise.resolve({ result: mergeAuthorityJudge(ctx, make), stderr });
  } finally {
    process.stderr.write = real;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
