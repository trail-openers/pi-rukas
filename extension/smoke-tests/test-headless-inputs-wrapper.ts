#!/usr/bin/env bun
/**
 * #1369 — the `--capabilities` inventory answers two questions a host could
 * otherwise only answer by reading pi-rukas source:
 *
 *   - which ids a family takes: `PI_ENSEMBLE_MODEL_<ROLE>` lists its roles in
 *     `members`, derived from the role list, the seam registry and the
 *     bundled lens roster (never a second hand-kept list);
 *   - which names only the sandbox wrapper reads: listed with scope
 *     `wrapper`, each read by `bin/` or the image entrypoint and never by
 *     `src/`.
 *
 * test-headless-inputs.ts covers the `src/` side of the scan. Each rule of
 * the shell scan is also run against a planted fixture.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SEAMS, isGrandfathered } from "../src/decision-seam-registry.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS, type HostInput } from "../src/headless/inputs.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { SUBAGENT_ROLE_NAMES } from "../src/roles.ts";
import { REPO_ROOT, scanShell, wrapperEnvReads } from "./lib/wrapper-env-reads.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const byName = (n: string): HostInput | undefined => HEADLESS_INPUTS.find((e) => e.name === n);
const envId = (id: string) => id.toUpperCase().replaceAll("-", "_");
const same = (a: readonly string[] | undefined, b: readonly string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

// ── Families carry their members, from the source of truth.
{
  const families = HEADLESS_INPUTS.filter((e) => e.name.includes("<"));
  assert(families.length >= 8, `the inventory has its families (${families.length})`);
  const bare = families.filter((e) => !(e.members && e.members.length > 0));
  assert(
    bare.length === 0,
    `every family lists its members${bare.length ? ` — none: ${bare.map((e) => e.name).join(", ")}` : ""}`,
  );
  const stray = HEADLESS_INPUTS.filter((e) => !e.name.includes("<") && e.members);
  assert(stray.length === 0, "only a family carries members");

  const roles = SUBAGENT_ROLE_NAMES.map(envId);
  for (const n of ["MODEL_<ROLE>", "PROVIDER_<ROLE>", "TOKEN_BUDGET_<ROLE>"]) {
    assert(
      same(byName(`PI_ENSEMBLE_${n}`)?.members, roles),
      `PI_ENSEMBLE_${n} members are the spawned roles (${roles.join(", ")})`,
    );
  }
  const model = byName("PI_ENSEMBLE_MODEL_<ROLE>")?.members ?? [];
  assert(
    model.includes("CODE_REVIEW_SPECIALIST") && !model.includes("PROJECT_MANAGER"),
    "the parent session is not a <ROLE> member",
  );

  const seams = Object.values(SEAMS)
    .filter((s) => !isGrandfathered(s))
    .map((s) => envId(s.id))
    .sort();
  assert(seams.length > 0, `the registry has env-configurable seams (${seams.join(", ")})`);
  for (const n of [
    "DECISION_BUDGET_<SEAM>",
    "DECISION_MODE_<SEAM>",
    "DECISION_TIMEOUT_MS_<SEAM>",
  ]) {
    assert(
      same(byName(`PI_ENSEMBLE_${n}`)?.members, seams),
      `PI_ENSEMBLE_${n} members are the seams`,
    );
  }
  assert(
    !(byName("PI_ENSEMBLE_DECISION_MODE_<SEAM>")?.members ?? []).includes("POLICY_JUDGE"),
    "a grandfathered seam, which ignores env config, is not a member",
  );
  const mode = byName("PI_ENSEMBLE_DECISION_MODE_<SEAM>");
  assert(
    same(mode?.values, ["off", "shadow", "enforce"]),
    "an enum family keeps its values beside its members",
  );

  const lenses = [...new Set(LENS_ROSTER.map((e) => e.name))];
  assert(lenses.includes("SECURITY"), `the bundled lens roster is read (${lenses.join(", ")})`);
  for (const n of ["MODEL_LENS_<LENS>", "PROVIDER_LENS_<LENS>"]) {
    assert(
      same(byName(`PI_ENSEMBLE_${n}`)?.members, lenses),
      `PI_ENSEMBLE_${n} members are the lenses`,
    );
  }
}

// ── The shell scan: planted fixture, each rule observed.
{
  const planted = new Map<string, string>();
  scanShell(
    [
      "# ${PI_ENSEMBLE_IN_A_COMMENT}",
      '  # opt out with "$PI_ENSEMBLE_INDENTED_COMMENT"',
      'X="${PI_ENSEMBLE_PLANTED_DEFAULT:-x}"',
      'if [ "$PI_ENSEMBLE_PLANTED_BARE" = "1" ]; then :; fi',
      "envs+=(-e PI_ENSEMBLE_PLANTED_SET=1)",
      "  LC_*|PI_ENSEMBLE_*|BASH_FUNC_*) continue ;;",
    ].join("\n"),
    "planted.sh",
    planted,
  );
  assert(
    same([...planted.keys()].sort(), ["PI_ENSEMBLE_PLANTED_BARE", "PI_ENSEMBLE_PLANTED_DEFAULT"]),
    `the shell scan sees expansions only (${[...planted.keys()].join(", ")})`,
  );
}

// ── Every wrapper read is listed; every wrapper-scope entry is wrapper-only.
const reads = wrapperEnvReads();
assert(reads.has("PI_ENSEMBLE_NO_SSH"), `the wrapper scan finds its reads (${reads.size} names)`);
{
  const unlisted = [...reads].filter(([n]) => !byName(n)).map(([n, f]) => `${n} (${f})`);
  assert(
    unlisted.length === 0,
    `every PI_ENSEMBLE_* the wrapper reads is listed${unlisted.length ? ` — ${unlisted.join(", ")}` : ""}`,
  );
  const srcRoot = path.join(REPO_ROOT, "extension", "src");
  const src = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && f !== path.join("headless", "inputs.ts"))
    .map((f) => readFileSync(path.join(srcRoot, f), "utf8"))
    .join("\n")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join("\n");
  const scoped = HEADLESS_INPUTS.filter((e) => e.scope === "wrapper");
  for (const n of [
    "PI_ENSEMBLE_HOST_ALIASES",
    "PI_ENSEMBLE_IMAGE",
    "PI_ENSEMBLE_IMAGE_DIRS",
    "PI_ENSEMBLE_NO_DOCKER_SOCKET",
    "PI_ENSEMBLE_NO_SSH",
  ]) {
    assert(byName(n)?.scope === "wrapper", `${n} is listed with scope wrapper`);
  }
  for (const e of scoped) {
    assert(
      reads.has(e.name),
      `${e.name} is read by the wrapper (${reads.get(e.name) ?? "no read"})`,
    );
    assert(
      !new RegExp(`\\b${e.name}\\b`).test(src),
      `${e.name} is not read in src/ (else its scope is not wrapper)`,
    );
  }
}

// ── Listed wrapper defaults agree with the wrapper's own fallbacks.
{
  const wrapper = readFileSync(path.join(REPO_ROOT, "bin", "pi-rukas"), "utf8");
  const image = wrapper.match(/\$\{PI_ENSEMBLE_IMAGE:-([^}]+)\}/)?.[1];
  assert(
    image !== undefined && byName("PI_ENSEMBLE_IMAGE")?.default === image,
    `PI_ENSEMBLE_IMAGE default matches the wrapper (${image})`,
  );
  // The wrapper registers no host of its own: unset or empty, it emits nothing —
  // not even the NUL an empty printf would leave behind — so no stray argument
  // reaches `docker run`. With a value it emits one NUL-separated flag per pair.
  {
    const runAlias = (value: string | undefined) => {
      const env: Record<string, string | undefined> = { ...process.env };
      if (value === undefined) delete env.PI_ENSEMBLE_HOST_ALIASES;
      else env.PI_ENSEMBLE_HOST_ALIASES = value;
      const wrapperPath = path.join(REPO_ROOT, "bin", "pi-rukas");
      const script = `set -e
source <(sed -n '/^build_host_aliases()/,/^[}]/p' "${wrapperPath}")
build_host_aliases | tr '\\0' '|'`;
      const r = spawnSync("bash", ["-c", script], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      // A probe that never produced an exit status (killed, unspawnable) is a
      // probe failure, never an empty result the assertions could compare.
      if (r.error || r.status === null) {
        const why = r.error?.message ?? `signal ${r.signal}`;
        throw new Error(`host-alias probe did not run: ${why}\n${r.stderr ?? ""}`);
      }
      if (r.status !== 0) {
        throw new Error(`host-alias probe exited ${r.status}:\n${r.stderr ?? ""}`);
      }
      return (r.stdout || "").replace(/\|$/, "");
    };
    // Positive control: a value that must produce output, so the two empty
    // assertions below cannot pass vacuously on a probe that ran nothing.
    assert(
      runAlias("gateway:192.0.2.10,db:198.51.100.20") ===
        "--add-host=gateway:192.0.2.10|--add-host=db:198.51.100.20",
      "HOST_ALIASES renders one --add-host per pair",
    );
    assert(runAlias(undefined) === "", "unset HOST_ALIASES adds no --add-host");
    assert(runAlias("") === "", "empty HOST_ALIASES adds no --add-host and no stray NUL");
  }
  assert(
    byName("PI_ENSEMBLE_HOST_ALIASES")?.default === "",
    "the listed HOST_ALIASES default is the empty string (no host ships)",
  );
  assert(
    !/--add-host=[^$"]/.test(wrapper),
    "the wrapper adds no alias when the variable is unset (no hardcoded --add-host)",
  );
  const dirs = wrapper.match(/default_image_dirs="([^"]*)"/)?.[1]?.replaceAll("$HOME", "~");
  assert(
    dirs !== undefined && byName("PI_ENSEMBLE_IMAGE_DIRS")?.default === dirs,
    `PI_ENSEMBLE_IMAGE_DIRS default matches the wrapper (${dirs})`,
  );
}

// ── The capabilities JSON carries both, additively.
{
  const caps = JSON.parse(JSON.stringify(buildCapabilities())) as {
    inputs: HostInput[];
  };
  const model = caps.inputs.find((e) => e.name === "PI_ENSEMBLE_MODEL_<ROLE>");
  assert(model?.members?.includes("DEVELOPER") === true, "the JSON family entry lists its members");
  const noSsh = caps.inputs.find((e) => e.name === "PI_ENSEMBLE_NO_SSH");
  assert(noSsh?.scope === "wrapper" && noSsh.type === "boolean", "the JSON lists a wrapper input");
}

process.exit(exit);
