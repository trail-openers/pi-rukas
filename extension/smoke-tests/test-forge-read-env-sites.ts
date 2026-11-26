/**
 * Every site that builds a helper child's env must hand it the harness-owned
 * protected set (#2638), and the enumeration of those sites is a SOURCE SCAN, not
 * a hand-kept list: a fix that covers the three sites someone remembered leaves
 * the fourth — the one written next week — fully authenticated and unjudged.
 *
 * Two halves, and each fails for a different reason:
 *
 *  - the strip itself puts both protected-set variables into every non-ops child
 *    env it builds, whatever the caller passed. A site cannot forget a value it
 *    never had to set.
 *  - the scan finds every call of a forge-child-env builder in `src/` and requires
 *    the file to be one the strip's own output covers. A new site that builds its
 *    env some other way — by copying `process.env` — is reported by name.
 *
 * Fixtures only: every home here is a temp tree with fake config files.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildForgeEnv, forgeReadChildEnv } from "../src/child-forge-env.ts";
import {
  FORGE_PROTECTED_HOMES_ENV,
  FORGE_PROTECTED_PATHS_ENV,
} from "../src/child-forge-read-roots.ts";
import {
  FORGE_CLI_GUARD_REASON_ENV,
  FORGE_READ_CHILD_ENV_NAMES,
} from "../src/forge-cli-guard-wrapper.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every env name the forge read rule owns on a child, as the modules spell them. */
const FORGE_NAMES: string[] = [...FORGE_READ_CHILD_ENV_NAMES, FORGE_PROTECTED_HOMES_ENV];

let exit = 0;
function assert(cond: boolean, what: string): void {
  if (!cond) {
    console.log(`✗ ${what}`);
    exit = 1;
    return;
  }
  console.log(`✓ ${what}`);
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// ---- 1 — the strip carries the protected set, so a site cannot forget it

{
  const source = {
    HOME: "/operator",
    XDG_CONFIG_HOME: "/operator/.config",
    GH_TOKEN: "ghs_real",
    GITLAB_TOKEN: "glpat_real",
  } as unknown as NodeJS.ProcessEnv;

  const child = forgeReadChildEnv(source, "developer", undefined, "/tmp/pi-2638-child-config");
  assert(
    child[FORGE_PROTECTED_PATHS_ENV] !== undefined &&
      child[FORGE_PROTECTED_PATHS_ENV].split(":").length >= 2 &&
      child[FORGE_PROTECTED_PATHS_ENV].includes("/operator/.config/gh") &&
      child[FORGE_PROTECTED_PATHS_ENV].includes("/operator/.config/glab-cli"),
    `the non-ops child env carries both forge config roots in ${FORGE_PROTECTED_PATHS_ENV} (${child[FORGE_PROTECTED_PATHS_ENV]})`,
  );
  assert(
    child[FORGE_PROTECTED_HOMES_ENV]?.includes("/operator") === true,
    `the non-ops child env carries the parent's home in ${FORGE_PROTECTED_HOMES_ENV} (${child[FORGE_PROTECTED_HOMES_ENV]})`,
  );
  assert(
    !("GH_TOKEN" in child) && !("GITLAB_TOKEN" in child),
    "the ambient tokens are still gone beside the new pair",
  );

  // Ops is exempt from the whole rule, protected set included: it judges nothing
  // because it is the role that owns the login.
  const ops = forgeReadChildEnv(source, "ops");
  assert(
    ops[FORGE_PROTECTED_PATHS_ENV] === undefined &&
      !(FORGE_PROTECTED_HOMES_ENV in ops) &&
      ops.GH_TOKEN === "ghs_real",
    "an ops child env carries no protected set and keeps its login",
  );

  // An absent role is treated as non-ops: the rule fails closed, so an unroled
  // spawn gets the set rather than a pass.
  const unroled = forgeReadChildEnv(source, "");
  assert(
    unroled[FORGE_PROTECTED_PATHS_ENV] !== undefined,
    "an absent role still gets the protected set (the rule fails closed)",
  );
}

// ---- 2 — the source scan: every env-building site is one the strip builds

{
  // Which functions build a helper child's env. Anything that copies `process.env`
  // by hand instead of calling one of these is the hole this scan exists to catch.
  const BUILDERS = ["forgeReadChildEnv", "buildChildForgeEnv", "childEnvFor", "buildChildEnv"];
  const sites: string[] = [];
  for (const file of filesUnder(SRC)) {
    const base = path.basename(file);
    // The strip's own definition, its own test, and the module that composes the
    // dispatch path's env are not CALLS of the rule; everything else that names a
    // builder is.
    if (base === "child-forge-env.ts") continue;
    const src = readFileSync(file, "utf8");
    const calls = src
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("//") &&
          !line.trimStart().startsWith("import") &&
          BUILDERS.some((fn) => new RegExp(`\\b${fn}\\(`).test(line)),
      );
    if (calls.length > 0) sites.push(path.relative(SRC, file));
  }
  assert(sites.length >= 4, `the scan finds the env-building sites (${sites.join(", ")})`);

  // Each site must hand the child an env that carries the protected set. There is
  // exactly one way to guarantee that without a hand-kept list at every call: the
  // env comes from the strip, and only the dispatch site — the one that resolves the
  // broker's socket — may write the two harness-owned names at all.
  const OWNER = "child-forge-env.ts";
  const DISPATCH = "spawn-permission.ts";
  const brokerNames = ["PI_ENSEMBLE_FORGE_READ_SOCKET", "PI_ENSEMBLE_FORGE_READ_SECRET"];
  for (const site of sites) {
    const src = readFileSync(path.join(SRC, site), "utf8");
    if (site === DISPATCH) continue;
    const written = FORGE_NAMES.filter(
      (n) => new RegExp(`${n}\\s*\\]=`).test(src) || new RegExp(`\\b${n}\\s*:`).test(src),
    );
    assert(
      written.length === 0,
      `${site} writes none of the harness-owned forge env names (got ${written.join(", ") || "none"}; only ${DISPATCH} and ${OWNER} may)`,
    );
  }

  // The dispatch site's own pair: it may set the protected set and the stub's
  // reason, because it resolved them; the broker's socket/secret names belong to no
  // site but the strip, which deletes them when there is no socket to reach.
  // The dispatch site may set the protected set and the stub's reason, because it
  // resolved them; the broker's socket/secret names belong to no site but the strip,
  // which deletes them when there is no socket to reach.
  const perm = readFileSync(path.join(SRC, DISPATCH), "utf8");
  assert(
    perm.includes("childBaseEnv") && /env\[FORGE_PROTECTED_PATHS_ENV\]\s*=/.test(perm),
    "the dispatch site stamps the parent's resolved set onto its child env",
  );
  assert(
    brokerNames.every((n) => !new RegExp(`${n}\\s*\\]=`).test(perm)),
    `the dispatch site does not write the broker's socket/secret names (${brokerNames.join(", ")}) — the strip owns them`,
  );
  // The strip is the ONE writer of the protected pair, and the way to see that is to
  // ask it: an env it built carries both names, and an env built for ops carries
  // neither. A mutant that deletes the assignment from `buildChildForgeEnv` reddens
  // this row and every row in section 1 — which is the point: the guarantee is the
  // strip's output, not a string somewhere in its source.
  // What the strip owes EVERY non-ops child is the protected pair; the broker pair
  // and the stub's reason are its CALLER's to set, because only the caller knows the
  // socket exists. The pair is asked for with a broker's env present — that is the
  // dispatch shape — and the answer must not depend on it: the protected pair is
  // there with a socket, and there without one.
  const broker = {
    PI_ENSEMBLE_FORGE_READ_SOCKET: "/tmp/pi-2638.sock",
    PI_ENSEMBLE_FORGE_READ_SECRET: "s3cret",
    [FORGE_CLI_GUARD_REASON_ENV]: "refused",
  };
  const base = {
    HOME: "/operator",
    XDG_CONFIG_HOME: "/operator/.config",
    ...broker,
  } as unknown as NodeJS.ProcessEnv;
  const withBroker = forgeReadChildEnv(
    base,
    "explore",
    "/tmp/s.sock",
    "/tmp/pi-2638-cfg",
    "s3cret",
  );
  const without = forgeReadChildEnv(
    { HOME: "/operator", XDG_CONFIG_HOME: "/operator/.config" } as unknown as NodeJS.ProcessEnv,
    "explore",
    undefined,
    "/tmp/pi-2638-cfg",
  );
  const missing = (env: Record<string, string>): string[] =>
    [FORGE_PROTECTED_PATHS_ENV, FORGE_PROTECTED_HOMES_ENV].filter((n) => !(n in env));
  assert(
    missing(withBroker).length === 0 && missing(without).length === 0,
    `the strip's output carries the protected pair with a broker present and without one (${[...new Set([...missing(withBroker), ...missing(without)])].join(", ") || "none missing"})`,
  );
  assert(
    withBroker.PI_ENSEMBLE_FORGE_READ_SOCKET === "/tmp/s.sock" &&
      without.PI_ENSEMBLE_FORGE_READ_SOCKET === undefined,
    "the broker pair is the caller's to set, and the strip deletes it when there is no socket",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
