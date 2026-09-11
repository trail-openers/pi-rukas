#!/usr/bin/env bun
/**
 * #716 — the "mandatory oo" prefix for 12 verbose runners (pytest, cargo
 * test, bun test, …) is pure prose on the bash tool's argument string in
 * trust/sandbox mode, where agents.json is decorative. The fix is the
 * deterministic rewrite in oo-rewrite-guard.ts: a bare 12-item command at
 * the START of the quote-stripped string is mutated in place to `oo <cmd>`
 * in event.input.command for developer + ops subagents in trust/sandbox
 * mode. REWRITE ONLY — the hook never blocks, never warns, and degrades to
 * today's behaviour (inert) when the `oo` binary is absent at registration.
 *
 * Test surface (per the issue):
 *   1. Pure predicate over all 12 items × bare/prefixed/wrapped/chained/
 *      quoted/injection shapes (imported from the guard module).
 *   2. Hook-level: fakePi handler capture, event.input.command mutates to
 *      "oo <cmd>" and the handler returns undefined (no block) in
 *      trust/sandbox + developer/ops; inert (unmutated, undefined) in
 *      strict/headless (neither marker), other roles, non-bash tools.
 *   3. Graceful degradation: absent probe → hook inert for the whole
 *      session, probe ran exactly once (no per-call re-probe).
 *   4. Source-ordering canaries: registered before the sandbox/trust
 *      early-returns (like the other mode-independent guards) and the
 *      in-hook mode gate + role gate are present in source.
 */

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- the pure predicate

const { ooBarePrefix } = await import("../src/oo-rewrite-guard.ts");

const BARE_PREFIXES = [
  "pytest",
  "cargo test",
  "cargo clippy",
  "cargo build",
  "cargo nextest",
  "bun test",
  "bun run build",
  "npm test",
  "npm run build",
  "pnpm test",
  "yarn test",
  "go test",
];

// (a) All 12 bare prefixes rewrite, with and without argument suffixes.
for (const prefix of BARE_PREFIXES) {
  assert(ooBarePrefix(prefix) === prefix, `bare — ${prefix}`);
  assert(
    ooBarePrefix(`${prefix} --release`) === prefix,
    `bare + args — ${prefix} --release`,
  );
}
assert(ooBarePrefix("pytest tests/test_foo.py") === "pytest", "pytest tests/test_foo.py");
assert(
  ooBarePrefix("cargo build --release") === "cargo build",
  "cargo build --release (issue example)",
);

// (b) Already-oo-prefixed forms pass through unchanged (idempotency — the
// doctrine actively trains agents to already emit the prefixed form, and a
// double-rewrite would corrupt every subsequent command in the session).
for (const prefix of BARE_PREFIXES) {
  assert(ooBarePrefix(`oo ${prefix}`) === undefined, `already-oo — oo ${prefix}`);
}

// (c) Word-boundary semantics: a prefix embedded in a longer token is NOT a
// match (`bun test2` / `bun tests/` must not match `bun test`).
assert(ooBarePrefix("bun test2") === undefined, "word boundary — bun test2");
assert(ooBarePrefix("bun tests/") === undefined, "word boundary — bun tests/");
assert(ooBarePrefix("pytest3") === undefined, "word boundary — pytest3");
assert(ooBarePrefix("cargo buildx") === undefined, "word boundary — cargo buildx");
assert(
  ooBarePrefix("npm run build:prod") === undefined,
  "word boundary — npm run build:prod",
);

// (d) Wrapper-prefixed forms are OUT OF SCOPE (no stripLeadingWrappers):
// only a bare 12-item command at the START of the string matches.
for (const cmd of [
  "timeout 30 cargo test",
  "nice -n 5 bun test",
  "env FOO=1 pytest",
  "nohup cargo build",
  "cd x && cargo test",
]) {
  assert(ooBarePrefix(cmd) === undefined, `wrapper/chained no-match — ${cmd}`);
}

// (e) Injection vectors: BASH_COMMAND_INJECTION_CHARS anywhere in the
// quote-stripped command means no rewrite.
for (const cmd of [
  "cargo test && echo done",
  "pytest; rm -rf x",
  "cargo test $(rm x)",
  "bun test `id`",
  "npm test | tee log",
  "go test > out.txt",
  "pytest -k \"$x\"",
]) {
  assert(ooBarePrefix(cmd) === undefined, `injection no-match — ${cmd}`);
}
// A newline is an injection char (command chaining via line separator).
assert(ooBarePrefix("cargo test\nrm x") === undefined, "injection no-match — newline");

// (f) Quoted operators are NOT injection (issue #108 semantics —
// stripQuotedSegments removes the segment before the injection check), so
// the rewrite fires and the ORIGINAL (unstripped) command gets the prefix.
assert(
  ooBarePrefix(`pytest -k "a && b"`) === "pytest",
  `quoted operator is not injection — pytest -k "a && b"`,
);
assert(
  ooBarePrefix("pytest 'cargo test'") === "pytest",
  `single-quoted argument — pytest 'cargo test'`,
);

// (g) Leading whitespace is tolerated (the predicate trims).
assert(ooBarePrefix("  cargo test") === "cargo test", "leading whitespace —   cargo test");

// (h) Not in the list at all.
for (const cmd of ["cargo fmt", "uv run pytest", "pip install x", "ls", "bun run lint", ""]) {
  assert(ooBarePrefix(cmd) === undefined, `not in list — ${cmd || "(empty)"}`);
}

// ------------------------------------------------------- the hook behaviour

type Handler = (
  event: { toolName: string; input: unknown },
  ctx: { hasUI: boolean },
) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined;

function captureOoHandlers(opts?: { probe?: () => boolean }) {
  const handlers: Handler[] = [];
  const fakePi = {
    on(event: string, handler: Handler) {
      if (event === "tool_call") handlers.push(handler);
    },
  } as unknown as Parameters<typeof registerGuard>[0];
  registerGuard(fakePi, opts);
  return handlers;
}

const { registerOoRewriteGuard: registerGuard, resetOoBinaryCache, ooBinaryAvailable } = await import(
  "../src/oo-rewrite-guard.ts"
);

const prevSandbox = process.env.PI_ENSEMBLE_SANDBOX_MODE;
const prevTrust = process.env.PI_ENSEMBLE_TRUST_MODE;
const prevRole = process.env.PI_ENSEMBLE_ROLE;
const save = () => ({
  sandbox: process.env.PI_ENSEMBLE_SANDBOX_MODE,
  trust: process.env.PI_ENSEMBLE_TRUST_MODE,
  role: process.env.PI_ENSEMBLE_ROLE,
});
const restore = (s: { sandbox: string | undefined; trust: string | undefined; role: string | undefined }) => {
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("PI_ENSEMBLE_SANDBOX_MODE", s.sandbox);
  set("PI_ENSEMBLE_TRUST_MODE", s.trust);
  set("PI_ENSEMBLE_ROLE", s.role);
};

const MODES: Array<{ name: string; sandbox: string | undefined; trust: string | undefined }> = [
  { name: "trust", sandbox: undefined, trust: "1" },
  { name: "sandbox", sandbox: "1", trust: undefined },
  { name: "strict/headless (neither marker)", sandbox: undefined, trust: undefined },
];
const ROLES = ["developer", "ops", "explore", "code-review-specialist", "adversarial-developer"] as const;

for (const mode of MODES) {
  for (const role of ROLES) {
    const base = save();
    process.env.PI_ENSEMBLE_SANDBOX_MODE = mode.sandbox;
    process.env.PI_ENSEMBLE_TRUST_MODE = mode.trust;
    process.env.PI_ENSEMBLE_ROLE = role;

    resetOoBinaryCache();
    let probeCalls = 0;
    const handlers = captureOoHandlers({ probe: () => (probeCalls++, true) });
    assert(handlers.length === 1, `hook: one tool_call handler registered (${mode.name} / ${role})`);
    const h = handlers[0];

    const shouldFire = (mode.name !== "strict/headless (neither marker)") && (role === "developer" || role === "ops");
    const input = { command: "cargo build --release" };
    const result = await h({ toolName: "bash", input }, { hasUI: true });

    if (shouldFire) {
      assert(result === undefined, `fires: no block returned (${mode.name} / ${role})`);
      assert(input.command === "oo cargo build --release", `fires: command rewritten to oo <cmd> (${mode.name} / ${role})`);
      assert(probeCalls === 1, `fires: oo probe ran exactly once (${mode.name} / ${role})`);
    } else {
      assert(result === undefined, `inert: no block returned (${mode.name} / ${role})`);
      assert(input.command === "cargo build --release", `inert: command unmutated (${mode.name} / ${role})`);
    }
    // Non-bash tools: untouched, and no probe re-run from a no-op call.
    const input2 = { command: "cargo test" };
    await h({ toolName: "read", input: input2 }, { hasUI: true });
    assert(input2.command === "cargo test", `non-bash untouched (${mode.name} / ${role})`);
    restore(base);
    resetOoBinaryCache();
  }
}

// ------------------------------------------------------ graceful degradation

// Absent probe → hook inert for the whole session: no rewrite, and the
// probe ran EXACTLY ONCE at registration (no per-call re-probing).
{
  resetOoBinaryCache();
  let probeCalls = 0;
  const handlers = captureOoHandlers({
    probe: () => {
      probeCalls++;
      return false;
    },
  });
  assert(handlers.length === 0, "absent oo: no tool_call handler is ever registered");
  const base = save();
  process.env.PI_ENSEMBLE_TRUST_MODE = "1";
  process.env.PI_ENSEMBLE_ROLE = "developer";
  assert(probeCalls === 1, "absent oo: probe ran exactly once (no per-call re-probe)");
  assert(ooBinaryAvailable() === false, "absent oo: probe result cached for the session");
  restore(base);
  resetOoBinaryCache();
}

// ------------------------------------------------------ source-ordering canaries

{
  const path = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const srcDir = path.resolve(import.meta.dirname, "..", "src");
  const sub = readFileSync(path.join(srcDir, "permission-subagent-guard.ts"), "utf8");
  const guard = readFileSync(path.join(srcDir, "oo-rewrite-guard.ts"), "utf8");

  const regIdx = sub.indexOf("registerOoRewriteGuard(pi)");
  const sandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE === \"1\"");
  const trustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE === \"1\"");
  assert(regIdx > 0, "canary: registerSubagentGuard calls registerOoRewriteGuard");
  assert(
    regIdx < sandboxIdx && regIdx < trustIdx,
    `canary: registered BEFORE the sandbox short-circuit (=${sandboxIdx}) and trust return (=${trustIdx})`,
  );
  // The hook's own body carries the explicit mode gate (fires only when
  // sandbox OR trust) — the mode split is a guard clause, not placement.
  assert(
    /PI_ENSEMBLE_SANDBOX_MODE !== "1"/.test(guard) && /PI_ENSEMBLE_TRUST_MODE !== "1"/.test(guard),
    "canary: in-hook mode gate — fire only when sandbox OR trust",
  );
  // Role scope: developer + ops only, read in the hook body.
  assert(
    /role === "developer" \|\| role === "ops"/.test(guard),
    "canary: role gate is exactly developer + ops",
  );
  // REWRITE ONLY: the hook must never block anything. (The docstring mentions
  // `{ block: true }` to describe the contract; the canary checks for the
  // actual code pattern `block: true` that would appear in a return statement.)
  assert(!/return\s*\{[^}]*block:\s*true/s.test(guard), "canary: no block return anywhere in the guard (rewrite only)");
  // Wrapper-stripping is deliberately NOT used for the match predicate.
  assert(!/stripLeadingWrappers\s*\(/.test(guard), "canary: stripLeadingWrappers is not CALLED for the predicate");
  // Reuses the exported parser helpers for the injection gate.
  assert(/stripQuotedSegments/.test(guard) && /BASH_COMMAND_INJECTION_CHARS/.test(guard), "canary: reuses exported stripQuotedSegments + BASH_COMMAND_INJECTION_CHARS");
}

if (prevSandbox === undefined) delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
else process.env.PI_ENSEMBLE_SANDBOX_MODE = prevSandbox;
if (prevTrust === undefined) delete process.env.PI_ENSEMBLE_TRUST_MODE;
else process.env.PI_ENSEMBLE_TRUST_MODE = prevTrust;
if (prevRole === undefined) delete process.env.PI_ENSEMBLE_ROLE;
else process.env.PI_ENSEMBLE_ROLE = prevRole;

console.log(`\nexit ${exit}`);
process.exit(exit);
