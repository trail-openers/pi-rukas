#!/usr/bin/env bun
/**
 * Non-role dispatch canary — no `runSingleDispatch` call site may ever name
 * a role that `spawn.ts` does not know.
 *
 * Background: after a successful **mechanized** merge, `runMerged` used to call
 * `runSingleDispatch(ctx, state, "merged", "driver", …)` with a prompt thunk
 * reading *"no dispatch needed — short-circuit"*. The comment was aspirational:
 * `runSingleDispatch` really spawns, and `spawn.ts` throws `Unknown role:
 * driver` because "driver" is not a role. The throw became `dispatch-failed`;
 * the cycle returned before the `merged` event / checkout restoration /
 * worktree teardown; `STEP_FAILURE_POLICY.merged === "HALT"` routed a
 * genuinely-merged PR to handoff. That bug is fixed — the mechanized path now
 * records the driver's own work with `synthesizeDriverCompletion`
 * (`work-driver-events.ts`) — and this test is the canary that keeps it fixed:
 * it fails if ANY `runSingleDispatch` call site in `src/` ever names a
 * non-role again.
 *
 * Why a second canary when `test-mechanized-no-dispatch.ts` already scans for
 * this: that scan's matcher is single-line (`[^"]+` cannot cross a newline),
 * so it only catches single-line call shapes. Five of the seven live
 * `runSingleDispatch` call sites in `src/` are multi-line (the arguments are
 * line-broken), so a regression at one of them — the realistic shape, since
 * biome formats long call sites across lines — would sail through that
 * single-line check. This canary parses the balanced-paren argument list of
 * EVERY call site, single-line or not, and asserts the role argument against
 * `isRoleName`.
 */

import { ROLE_NAMES, isRoleName } from "../src/roles.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------- every dispatchable role is a real role (baseline)

// The first two lines are also the "known-good" baseline: `ops` and `developer`
// ARE spawnable roles, so a reader of the scan output can tell the real
// offenders apart from the ones the canary is supposed to catch.
assert(isRoleName("ops"), `canary: "ops" IS a spawnable role (roles are ${ROLE_NAMES.join(", ")})`);
assert(isRoleName("developer"), '...and so is "developer"');
assert(
  !isRoleName("driver"),
  'canary: "driver" is NOT a spawnable role — the regression this file guards against',
);
assert(!isRoleName("pm"), '...and neither is "pm" (owner kinds are not dispatch roles)');

// ------------------- extract the role argument from a call expression

/**
 * Given the source text and the index of the opening `(` of a
 * `runSingleDispatch(…)` call, walk forward balancing parens (string,
 * template and comment contents respected) and return the balanced argument
 * substring, or `undefined` when the expression is unbalanced (should not
 * happen on well-formed source).
 */
function balancedCallArgs(text: string, openParen: number): string | undefined {
  let depth = 0;
  let inStr: string | null = null; // ', " or `
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openParen; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  return undefined;
}

/** Split a balanced argument substring on top-level commas (strings-aware). */
function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    const n = args[i + 1];
    if (inStr) {
      cur += c;
      if (c === "\\") {
        cur += n ?? "";
        i++;
      } else if (c === inStr) {
        inStr = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/**
 * The role of a `runSingleDispatch(…)` argument list: the 4th positional
 * argument, as a bare identifier or a string literal. `undefined` when the
 * shape is not recognized (the caller decides what silence means).
 */
function roleOfCall(args: string): string | undefined {
  const parts = splitTopLevelArgs(args);
  if (parts.length < 4) return undefined;
  const roleRaw = (parts[3] ?? "").trim();
  if (roleRaw === "") return undefined;
  const m = roleRaw.match(/^["']([^"']+)["']$/);
  if (m) return m[1];
  const idm = roleRaw.match(/^[A-Za-z_$][\w$]*$/);
  if (idm) return roleRaw; // identifier — caller resolves or flags it
  return undefined;
}

// --------------------- scan every call site in src/, single or multi-line

{
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const SRC = path.resolve(import.meta.dirname, "..", "src");

  const callers: string[] = [];
  const offenders: string[] = [];
  const unresolved: string[] = [];
  let callSites = 0;

  for (const f of readdirSync(SRC)
    .filter((n) => n.endsWith(".ts"))
    .sort()) {
    let text = readFileSync(path.join(SRC, f), "utf8");
    // Strip comments so a call quoted in a doc header (e.g.
    // work-driver-events.ts describes the old `"driver"` dispatch) is not
    // counted as a live call site.
    text = text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => `${p1} `);
    for (const m of text.matchAll(/\brunSingleDispatch\s*\(/g)) {
      const args = balancedCallArgs(text, m.index + m[0].length - 1);
      if (args === undefined) continue; // unbalanced — malformed source
      callSites++;
      const role = roleOfCall(args);
      if (role === undefined) continue; // not a recognized call shape
      callers.push(`${f} :: ${role}`);
      if (!isRoleName(role)) {
        // A string literal naming a non-role is the regression. An
        // identifier (a variable holding the role) cannot be resolved
        // statically — record it so the scan's coverage is visible rather
        // than silently assumed.
        const isLiteral = /["']/.test((args.match(/^[^,]*/) ?? [])[0] ?? "");
        if (isLiteral) offenders.push(`${f}: role "${role}"`);
        else unresolved.push(`${f}: role identifier "${role}" (unresolved)`);
      }
    }
  }

  assert(callSites > 0, `canary: found ${callSites} runSingleDispatch call site(s) in src/`);
  assert(
    callers.length > 0,
    `canary: recognized call shapes — ${callers.length} site(s) with a resolvable role argument`,
  );
  assert(
    offenders.length === 0,
    `canary: no runSingleDispatch call site names a non-role${
      offenders.length ? ` — found: ${offenders.join(", ")}` : ""
    }`,
  );
  if (unresolved.length > 0) {
    console.log(
      `  note: ${unresolved.length} identifier-role site(s) not statically resolvable: ${unresolved.join(", ")}`,
    );
  }
}

// ------- proof that the multi-line shape the old single-line scan misses is
// ------- actually caught by this canary

{
  const sample = [
    "let x = await runSingleDispatch(",
    "  ctx,",
    "  state,",
    '  "merged",',
    '  "driver",',
    '  "driver:merge",',
    "  now,",
    '  () => "no dispatch needed — short-circuit",',
    ");",
  ].join("\n");
  const m = sample.match(/\brunSingleDispatch\s*\(/);
  const args = m ? balancedCallArgs(sample, m.index + m[0].length - 1) : undefined;
  const role = args !== undefined ? roleOfCall(args) : undefined;
  assert(
    role === "driver",
    'canary: the multi-line "driver" call shape (single-line scans miss this) is parsed and named',
  );
  assert(
    role !== undefined && !isRoleName(role),
    "...and flagged as a non-role, which is exactly the regression",
  );

  const good = [
    "let y = await runSingleDispatch(",
    "  ctx,",
    "  next,",
    '  "ci",',
    '  "ops",',
    '  "ops:ci",',
    "  now,",
    '  () => "x",',
    "  { timeoutMs: 1 },",
    ");",
  ].join("\n");
  const m2 = good.match(/\brunSingleDispatch\s*\(/);
  const args2 = m2 ? balancedCallArgs(good, m2.index + m2[0].length - 1) : undefined;
  const role2 = args2 !== undefined ? roleOfCall(args2) : undefined;
  assert(
    role2 === "ops" && isRoleName(role2),
    "a multi-line call with a real role parses cleanly and is not flagged",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
