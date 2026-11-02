#!/usr/bin/env bun
/**
 * One propagation path for a /work cycle's trust stamp (#1666).
 *
 * Sections, in execution order:
 *   1. Behaviour: cycleChildOpts and cycleDispatch stamp every child; a caller
 *      cannot opt a child out; an injected dispatchFn is used as given.
 *   2. Canary over source: the import closure of work-driver.ts (every module a
 *      cycle can reach) is audited. Only the cycle entry references dispatchCore;
 *      every spawnSpecialist call is in the registry below with the stamp it
 *      carries; nothing hand-computes the stamp from ctx.headless.
 *   3. The canary fails on a bad site: a fixture with an unregistered spawn, a
 *      direct dispatchCore and a hand-computed stamp each produce a violation.
 *   4. The lean engine's three dispatch sites are audited here too. `lean/`
 *      reaches `spawnSpecialist` directly rather than through a cycle entry, so
 *      the driver closure of section 2 cannot see them; they share THIS registry
 *      and this auditor, so one audit enforces the stamp for both engines
 *      (#1904 lens HIGH — a second, per-file regex was a second rule that could
 *      drift). A lean site stamped from a process flag instead of its run's
 *      threaded mode is caught by the same hand-computed-stamp rule.
 *
 * Adding a dispatch site to a /work cycle means adding it to REGISTRY with the
 * stamp it carries (and to docs/headless.md's audit table), or routing it through
 * cycleDispatch(ctx). The registry is the audit, kept honest by this file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import { cycleChildOpts } from "../src/work-cycle-trust.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { cycleDispatch } from "../src/work-driver-cycle-entry.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const SRC_DIR = new URL("../src/", import.meta.url).pathname;

/**
 * Every spawnSpecialist call in the cycle's closure, with the stamp it carries,
 * matched against its code lines (never comments). dispatch.ts holds three: the
 * dispatchCore path (stamped) and the two PM-only tools dispatch_specialist /
 * dispatch_parallel, which are not cycle children.
 */
const REGISTRY: Record<string, { spawnCalls: number; stamp: RegExp }> = {
  "dispatch.ts": { spawnCalls: 3, stamp: /^\s*workCycleTrust: opts\.workCycleTrust,$/m },
  "adversarial-phase.ts": { spawnCalls: 1, stamp: /^\s*workCycleTrust,$/m },
  "lens-review-child.ts": {
    spawnCalls: 1,
    stamp: /^\s*workCycleTrust: runOpts\.workCycleTrust,$/m,
  },
  "work-driver-policy.ts": { spawnCalls: 1, stamp: /^\s*workCycleTrust,$/m },
};

/** Files allowed to name dispatchCore: its definition and the one cycle entry. */
const CORE_OWNERS = new Set(["dispatch.ts", "work-driver-cycle-entry.ts"]);

/**
 * The registry section 4 audits the lean closure against: only the lean
 * dispatch sites. Kept separate from `REGISTRY` because the driver's closure
 * never loads `lean/` and the auditor reports a registry entry it cannot see —
 * one list would fail section 2 for files it legitimately cannot reach.
 */
const LEAN_REGISTRY: typeof REGISTRY = {
  "lean/build.ts": { spawnCalls: 1, stamp: /^\s*\.\.\.leanChildOpts\(headless\),$/m },
  "lean/challenge.ts": { spawnCalls: 1, stamp: /^\s*\.\.\.leanChildOpts\(headless\),$/m },
  "lean/command.ts": { spawnCalls: 1, stamp: /^\s*\.\.\.leanChildOpts\(headless\),$/m },
  // The review step's fixer and its two gates. Same threaded-mode stamp as its
  // siblings: every dispatch is `reviewDeps(headless)`'s, so the stamp comes from
  // the run's mode the deps builder was built with, never a process flag. The
  // deps live apart from the decision procedure (`review-deps.ts`) so the step's
  // judgement is drivable with stubs and no child is ever spawned from the file
  // that decides — which is also why THIS is the file the auditor must see.
  "lean/review-deps.ts": { spawnCalls: 1, stamp: /^\s*\.\.\.leanChildOpts\(headless\),$/m },
};

/** The code on each line: whole-line comments dropped, trailing ` // …` comments cut. */
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .map((line) => line.replace(/\s\/\/.*$/, ""));
}

/**
 * True when a code line from `registerDispatchTools` on (the PM's dispatch_specialist /
 * dispatch_parallel tools, which are not cycle children) carries the cycle stamp. A
 * missing anchor counts as stamped: the audit fails closed rather than passing blind.
 */
function pmToolsStamped(lines: readonly string[]): boolean {
  const at = lines.findIndex((l) => /\bfunction registerDispatchTools\(/.test(l));
  if (at < 0) return true;
  return lines.slice(at).some((l) => /\bworkCycleTrust\b/.test(l));
}

/** Static and dynamic relative imports of a module, as normalised `.ts` paths. */
function importsOf(rel: string, text: string): string[] {
  const specs = [
    ...text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+\.ts)"/g),
    ...text.matchAll(/\bimport\(\s*"(\.{1,2}\/[^"]+\.ts)"\s*\)/g),
  ].map((m) => m[1] ?? "");
  return specs.map((s) => path.normalize(path.join(path.dirname(rel), s)));
}

/** The modules reachable from `root` through relative imports, with their text. */
function closureOf(root: string, readFn: (rel: string) => string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [root];
  while (queue.length > 0) {
    const rel = queue.shift() ?? "";
    if (seen.has(rel)) continue;
    const text = readFn(rel);
    seen.set(rel, text);
    queue.push(...importsOf(rel, text));
  }
  return seen;
}

/**
 * Audit the closure. Returns one line per violation; an empty list passes.
 * `files` is keyed by the file's basename (the registry's keys).
 */
function auditDispatchSites(
  files: ReadonlyMap<string, string>,
  registry: typeof REGISTRY,
): string[] {
  const violations: string[] = [];
  for (const [file, text] of files) {
    const lines = codeLines(text);
    const coreRefs = lines.filter((l) => /\bdispatchCore\b/.test(l)).length;
    if (coreRefs > 0 && !CORE_OWNERS.has(file)) {
      violations.push(`${file}: names dispatchCore (${coreRefs}); use cycleDispatch(ctx)`);
    }
    const spawnCalls = lines.filter(
      (l) => /\bspawnSpecialist\(/.test(l) && !/function\s+spawnSpecialist\(/.test(l),
    ).length;
    const entry = registry[file];
    if (spawnCalls > 0 && entry === undefined) {
      violations.push(`${file}: ${spawnCalls} spawnSpecialist call(s) not in the audit registry`);
    } else if (entry !== undefined && spawnCalls !== entry.spawnCalls) {
      violations.push(
        `${file}: ${spawnCalls} spawnSpecialist call(s), the registry says ${entry.spawnCalls}`,
      );
    } else if (entry !== undefined && !entry.stamp.test(lines.join("\n"))) {
      violations.push(`${file}: carries no stamp (expected ${entry.stamp})`);
    }
    if (file === "dispatch.ts" && pmToolsStamped(lines)) {
      violations.push(
        `${file}: the PM tools (dispatch_specialist, dispatch_parallel) carry the stamp`,
      );
    }
    if (
      file !== "work-cycle-trust.ts" &&
      lines.some((l) => /workCycleTrust\s*:[^,]*headless/.test(l))
    ) {
      violations.push(
        `${file}: hand-computes the trust stamp from headless; use cycleChildOpts(ctx)`,
      );
    }
  }
  for (const f of Object.keys(registry)) {
    if (!files.has(f)) violations.push(`${f}: in the registry but not in the driver closure`);
  }
  return violations;
}

/**
 * The same audit over the lean engine's own closure (#1904 lens HIGH).
 *
 * `lean/` dispatches through `spawnSpecialist` directly — there is no cycle
 * entry and no `dispatchCore` in its closure — so section 2's root cannot reach
 * it. Rather than let the lean tests keep their own regex over the three sites
 * (a second rule for the same invariant, which can drift from this one in
 * either direction), the three roots are closed over here with the SAME
 * registry and the SAME auditor.
 */
function auditLeanDispatchSites(readFn: (rel: string) => string): string[] {
  const files = new Map<string, string>();
  for (const root of ["lean/build.ts", "lean/challenge.ts", "lean/command.ts"]) {
    for (const [rel, text] of closureOf(root, readFn)) {
      if (rel.startsWith("lean/")) files.set(rel, text);
    }
  }
  const violations = auditDispatchSites(files, LEAN_REGISTRY);
  // The stamp must come from the RUN's mode, not the process: a lean site that
  // read a module-level flag would stamp every run in the host with the first
  // one's trust. `leanChildOpts`'s required argument is the compile-time half
  // of this; the source test below is the runtime half.
  for (const root of ["lean/build.ts", "lean/challenge.ts", "lean/command.ts"]) {
    const text = files.get(root) ?? "";
    if (
      /\.\.\.leanChildOpts\(\s*\)/.test(text) ||
      /\.\.\.leanChildOpts\((?!headless\))/.test(text)
    ) {
      violations.push(`${root}: spreads leanChildOpts with a value that is not its run's mode`);
    }
  }
  return violations;
}

const readSrc = (rel: string): string => readFileSync(path.join(SRC_DIR, rel), "utf8");

// ── 1. Behaviour: the stamp is derived once and cannot be opted out of.
{
  assert(
    cycleChildOpts({ headless: true }).workCycleTrust === true,
    "1: a headless cycle stamps its children",
  );
  assert(cycleChildOpts({}).workCycleTrust === false, "1: an interactive cycle stamps nothing");
  assert(
    cycleChildOpts({ headless: false }).workCycleTrust === false,
    "1: headless=false stamps nothing",
  );

  const recorded: unknown[] = [];
  const core = (async (_h: unknown, _spec: unknown, opts: unknown) => {
    recorded.push(opts);
    return { role: "developer", ok: true, text: "", toolUses: [], ms: 0 };
  }) as never;
  const headless = {
    issue: 1,
    repoRoot: "/x",
    host: {},
    headless: true,
  } as unknown as DriverContext;
  const interactive = {
    issue: 1,
    repoRoot: "/x",
    host: {},
  } as unknown as DriverContext;
  const host = {} as DispatchHost;
  await cycleDispatch(headless, core)(host, { role: "developer", prompt: "p" }, {
    workCycleTrust: false,
  } as never);
  const seen = recorded[0] as { workCycleTrust?: boolean };
  assert(
    seen.workCycleTrust === true,
    "1: a caller's workCycleTrust=false cannot opt a headless child out",
  );
  await cycleDispatch(interactive, core)(host, {
    role: "developer",
    prompt: "p",
  });
  assert(
    (recorded[1] as { workCycleTrust?: boolean }).workCycleTrust === false,
    "1: an interactive child is not stamped",
  );
  const injected = (async () => ({
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 0,
  })) as never;
  assert(
    cycleDispatch({ ...headless, dispatchFn: injected }, core) === injected,
    "1: an injected dispatchFn is used as given",
  );
}

// ── 2. Canary over the driver's real closure.
{
  const closure = closureOf("work-driver.ts", readSrc);
  for (const must of [
    "work-driver-lens.ts",
    "work-driver-merged.ts",
    "work-driver-adversarial-fanout.ts",
    "work-driver-policy.ts",
    "adversarial-phase.ts",
    "lens-review-child.ts",
    "work-driver-cycle-entry.ts",
  ]) {
    assert(closure.has(must), `2: ${must} is reachable from work-driver.ts (the audit covers it)`);
  }
  assert(
    !pmToolsStamped(codeLines(closure.get("dispatch.ts") ?? "")),
    "2: the PM dispatch tools (dispatch_specialist, dispatch_parallel) are not stamped",
  );
  const violations = auditDispatchSites(closure, REGISTRY);
  assert(
    violations.length === 0,
    `2: every driver-reachable dispatch site is stamped${violations.length ? `: ${violations.join("; ")}` : ""}`,
  );
}

// ── 3. The canary fails on a bad site (it is not vacuous).
{
  const bad = new Map<string, string>([
    [
      "work-driver-new.ts",
      'import { spawnSpecialist } from "./spawn.ts";\nawait spawnSpecialist({ role: "explore", prompt: "p" }, {});\n',
    ],
    [
      "work-driver-raw.ts",
      'import { dispatchCore } from "./dispatch.ts";\nawait dispatchCore(host, spec, {});\n',
    ],
    ["work-driver-hand.ts", "const o = {\n  workCycleTrust: ctx.headless === true,\n};\n"],
    ["lens-review-child.ts", 'await spawnSpecialist({ role: "x" }, {}); // workCycleTrust\n'],
    [
      "dispatch.ts",
      "export function registerDispatchTools(pi) {\n  spawnSpecialist(spec, {\n    workCycleTrust: opts.workCycleTrust,\n  });\n}\n",
    ],
  ]);
  const violations = auditDispatchSites(bad, REGISTRY);
  assert(
    violations.some((v) => v.startsWith("dispatch.ts") && v.includes("PM tools")),
    "3: a cycle stamp on a PM dispatch tool is caught",
  );
  assert(
    violations.some((v) => v.startsWith("work-driver-new.ts")),
    "3: an unregistered spawn is caught",
  );
  assert(
    violations.some((v) => v.startsWith("work-driver-raw.ts")),
    "3: a direct dispatchCore is caught",
  );
  assert(
    violations.some((v) => v.startsWith("work-driver-hand.ts")),
    "3: a hand-computed stamp is caught",
  );
  assert(
    violations.some((v) => v.startsWith("dispatch.ts") || v.startsWith("adversarial-phase.ts")),
    "3: a registry entry missing from the closure is caught",
  );
}

// ── 4. The lean engine's three dispatch sites, audited by THIS file.
{
  const violations = auditLeanDispatchSites(readSrc);
  assert(
    violations.length === 0,
    `4: every lean dispatch site is registered and stamped${violations.length ? `: ${violations.join("; ")}` : ""}`,
  );
  // Not vacuous: a lean site that stops spreading the stamp, and one that drops
  // the call from the registry, are both caught by the same auditor the driver
  // closure is judged by.
  const dropped = new Map<string, string>([
    [
      "lean/build.ts",
      'import { spawnSpecialist } from "../spawn.ts";\nawait spawnSpecialist(spec, { workCycleTrust: false });\n',
    ],
  ]);
  const silent = auditDispatchSites(dropped, LEAN_REGISTRY);
  assert(
    silent.some((v) => v.startsWith("lean/build.ts") && v.includes("no stamp")),
    "4: a lean dispatch site that carries no stamp is caught",
  );
  const unregistered = new Map<string, string>([
    [
      "lean/engine.ts",
      'import { spawnSpecialist } from "../spawn.ts";\nawait spawnSpecialist(spec, {});\n',
    ],
  ]);
  const orphan = auditDispatchSites(unregistered, LEAN_REGISTRY);
  assert(
    orphan.some((v) => v.startsWith("lean/engine.ts") && v.includes("not in the audit registry")),
    "4: an unregistered lean dispatch site is caught",
  );
  const constant = new Map<string, string>([
    [
      "lean/build.ts",
      'import { spawnSpecialist } from "../spawn.ts";\nawait spawnSpecialist(spec, {\n  ...leanChildOpts(true),\n});\n',
    ],
  ]);
  const stamped = auditDispatchSites(constant, LEAN_REGISTRY);
  assert(
    stamped.some((v) => v.startsWith("lean/build.ts") && v.includes("carries no stamp")),
    "4: a lean site stamping from a literal rather than its run's mode is caught",
  );
  const handMode = auditLeanDispatchSites((rel) =>
    rel === "lean/build.ts"
      ? 'import { spawnSpecialist } from "../spawn.ts";\nawait spawnSpecialist(spec, {\n  ...leanChildOpts(PROCESS_TRUST),\n});\n'
      : readSrc(rel),
  );
  assert(
    handMode.some((v) => v.startsWith("lean/build.ts") && v.includes("not its run's mode")),
    "4: a lean site stamping from anything but its threaded mode is caught",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
