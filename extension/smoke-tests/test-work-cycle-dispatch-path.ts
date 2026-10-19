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
 * Every spawnSpecialist call in the cycle's closure, with the stamp it carries.
 * dispatch.ts holds three: the dispatchCore path (stamped) and the two PM-only
 * tools dispatch_specialist / dispatch_parallel, which are not cycle children.
 */
export const REGISTRY: Record<string, { spawnCalls: number; stamp: string }> = {
  "dispatch.ts": {
    spawnCalls: 3,
    stamp: "workCycleTrust: opts.workCycleTrust",
  },
  "adversarial-phase.ts": { spawnCalls: 1, stamp: "workCycleTrust" },
  "lens-review-child.ts": { spawnCalls: 1, stamp: "workCycleTrust" },
  "work-driver-policy.ts": { spawnCalls: 1, stamp: "workCycleTrust" },
};

/** Files allowed to name dispatchCore: its definition and the one cycle entry. */
const CORE_OWNERS = new Set(["dispatch.ts", "work-driver-cycle-entry.ts"]);

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

/** Static and dynamic relative imports of a module, as normalised `.ts` paths. */
export function importsOf(rel: string, text: string): string[] {
  const specs = [
    ...text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+\.ts)"/g),
    ...text.matchAll(/\bimport\(\s*"(\.{1,2}\/[^"]+\.ts)"\s*\)/g),
  ].map((m) => m[1] ?? "");
  return specs.map((s) => path.normalize(path.join(path.dirname(rel), s)));
}

/** The modules reachable from `root` through relative imports, with their text. */
export function closureOf(root: string, readFn: (rel: string) => string): Map<string, string> {
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
export function auditDispatchSites(
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
    } else if (entry !== undefined && !text.includes(entry.stamp)) {
      violations.push(`${file}: carries no stamp (expected "${entry.stamp}")`);
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
  ]);
  const violations = auditDispatchSites(bad, REGISTRY);
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

console.log(`\nexit ${exit}`);
process.exit(exit);
