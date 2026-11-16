#!/usr/bin/env bun
/**
 * #2284 — `none` has ONE reader, and `forge-read-broker.ts` is not it.
 *
 * `detectForge` honours `PI_ENSEMBLE_FORGE` only for `github`/`gitlab`; any other
 * value is traced as unrecognised and falls through to `.pi/forge` and the remote.
 * `resolveCycleForge` short-circuits `none` BEFORE that. The broker went straight to
 * `detectForge`, so the two disagreed and the offline contract ("no detection, no
 * `gh`/`glab` call") leaked through the child-facing path.
 *
 * The fix is a predicate both consumers call, in a module of its own
 * (`forge-off.ts`). A comment or a review note cannot keep that true, so this is a
 * grep-based source assertion (precedent: `test-forge-no-cycle.ts`,
 * `test-doctrine-issue-ownership.ts`) pinning three facts:
 *
 *   1. the predicate exists and is exact (`=== "none"`, the raw value — a trim or a
 *      case fold here would make a value the driver reads as a forge be off for the
 *      broker, which is the same disagreement in the other direction);
 *   2. `forge-read-broker.ts` CALLS it and contains no `PI_ENSEMBLE_FORGE` literal
 *      of its own, so the broker cannot quietly grow a second, looser comparison;
 *   3. `resolveCycleForge` calls it too — one reader means BOTH consumers, not a
 *      new one beside the old.
 *
 * The `PI_ENSEMBLE_FORGE_READ_*` pair (the broker's socket and key names) is
 * deliberately not the literal this pins, so the assertion looks for the exact
 * variable name rather than the prefix.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const src = (f: string): string =>
  readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");

const off = src("forge-off.ts");
assert(
  /export function forgeEnvIsOff\(/.test(off),
  "forge-off.ts exports the predicate forgeEnvIsOff",
);
assert(
  /env\.PI_ENSEMBLE_FORGE\s*===\s*"none"/.test(off),
  'and it is an EXACT comparison against the raw value (env.PI_ENSEMBLE_FORGE === "none")',
);
assert(
  !/toLowerCase|trim\(\)/.test(off),
  "which folds no case and trims nothing, matching what resolveCycleForge did before",
);
assert(
  /env: Record<string, string \| undefined> = process\.env/.test(off),
  "and it takes an env bag, defaulting to process.env, so the driver's injected bag still works",
);

const broker = src("forge-read-broker.ts");
assert(
  broker.includes("forgeEnvIsOff"),
  "forge-read-broker.ts calls the shared predicate rather than spelling a comparison",
);
assert(
  /import\s*\{[^}]*forgeEnvIsOff[^}]*\}\s*from\s*"\.\/forge-off\.ts"/.test(broker),
  "and imports it from forge-off.ts",
);
assert(
  !/"PI_ENSEMBLE_FORGE"|'PI_ENSEMBLE_FORGE'|\bPI_ENSEMBLE_FORGE\s*===/.test(broker),
  "forge-read-broker.ts holds no PI_ENSEMBLE_FORGE literal or comparison of its own",
);
assert(
  broker.includes("forge-read-off-switch.ts"),
  "and the refusal sits behind its own switch's reader",
);

const ctx = src("work-driver-forge-ctx.ts");
assert(
  ctx.includes("forgeEnvIsOff"),
  "work-driver-forge-ctx.ts calls the same predicate (one reader, both consumers)",
);
assert(
  !/\.PI_ENSEMBLE_FORGE\s*===\s*"none"/.test(ctx),
  "and no longer compares the value inline",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
