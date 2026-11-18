/**
 * test-reviewer-scratch-home-coding-agent-dir — the pi config dir a confined
 * child must keep when its `HOME` is redirected (#2368 regression).
 *
 * The outage: since the scratch-HOME redirect shipped, every read-only child
 * (`explore`, `code-review-specialist`, `adversarial-developer`, a `/plan`
 * investigator) died about eight seconds after spawn with
 * `Error: Unknown provider "<id>". Use --list-models to see available
 * providers/models.` while developer and ops children ran. The redirect is
 * applied to the CHILD PROCESS env, so the child's own pi resolves its config
 * directory from the scratch `HOME`. Pi reads that directory from
 * `PI_CODING_AGENT_DIR` and falls back to `<HOME>/.pi/agent` (pi `config.js`
 * `getAgentDir`, with `ENV_AGENT_DIR` = `PI_CODING_AGENT_DIR`); the re-export
 * list carried only `PI_AGENT_DIR`, a name pi never reads, so the child opened
 * `<scratch>/.pi/agent` — a directory with no `models.json`, no `auth.json` and
 * no `settings.json` — and its model resolution failed before its first turn.
 *
 * So `PI_CODING_AGENT_DIR` must be re-exported at the value the PARENT resolves,
 * exactly as `VIPUNE_DATABASE_PATH` is (#2357): a variable whose default is
 * derived from `HOME` is not protected by re-exporting some other variable's
 * name.
 *
 * The assertions go through `buildChildEnv` — the one production env builder
 * `spawn.ts` calls — rather than the inner helper, because the defect was
 * invisible at the helper level: the helper re-exported the wrong name
 * faithfully.
 *
 * The unset arm is asked of `reviewerScratchHomeEnv` directly, which takes
 * `homedir` as a parameter: `buildChildEnv` has no such seam and its own default
 * is `os.homedir()`, which Bun snapshots at process start — pinning `HOME` here
 * would not move it, and a fixture that asserted against a value it could not
 * set is the kind of green that means nothing.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REEXPORTED_HOME_ROOTS, reviewerScratchHomeEnv } from "../src/reviewer-scratch-home.ts";

const CODING_AGENT_DIR = "PI_CODING_AGENT_DIR";
/** pi's own default, spelled as pi's `getAgentDir` computes it. */
const defaultAgentDir = (home: string): string => path.join(home, ".pi", "agent");

const plan = {
  forge: { socketPath: undefined, configDir: undefined, secret: undefined },
  ready: Promise.resolve(),
} as never;
const { buildChildEnv } = await import("../src/spawn-child-env.ts");

const childTmp = mkdtempSync(path.join(tmpdir(), "scratch-agent-dir-"));

/** The parent env, with the names this fixture owns pinned or removed. */
function parentEnv(pins: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(pins)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const PINNED = [CODING_AGENT_DIR, "PI_AGENT_DIR", "HOME"];
const saved: Record<string, string | undefined> = {};
for (const k of PINNED) saved[k] = process.env[k];

try {
  console.log("── the re-export list names the variable pi actually reads ──");
  assert.ok(
    (REEXPORTED_HOME_ROOTS as readonly string[]).includes(CODING_AGENT_DIR),
    `REEXPORTED_HOME_ROOTS carries ${CODING_AGENT_DIR} (${REEXPORTED_HOME_ROOTS.join(", ")})`,
  );
  assert.ok(
    (REEXPORTED_HOME_ROOTS as readonly string[]).includes("PI_AGENT_DIR"),
    "and keeps PI_AGENT_DIR, which pi-rukas's own modules read (spawn-support.ts, review-store-locator.ts)",
  );

  console.log("── a confined child keeps the parent's resolved pi config dir ──");
  const pinned = "/operator/.pi/agent";
  parentEnv({ [CODING_AGENT_DIR]: pinned, PI_AGENT_DIR: "/operator/rukas-agent" });
  const withVar = buildChildEnv("explore", plan, undefined, childTmp);
  assert.equal(
    withVar[CODING_AGENT_DIR],
    pinned,
    "parent's PI_CODING_AGENT_DIR is the value the child carries",
  );
  assert.notEqual(
    withVar[CODING_AGENT_DIR],
    path.join(withVar.HOME ?? "", ".pi", "agent"),
    "it is NOT the scratch-home default — that dir has no models.json/auth.json/settings.json",
  );
  assert.equal(
    withVar.PI_AGENT_DIR,
    "/operator/rukas-agent",
    "pi-rukas's own agent-dir name still survives the redirect",
  );

  console.log("── unset: the child gets the default the PARENT resolves, not the scratch's ──");
  parentEnv({ [CODING_AGENT_DIR]: undefined, PI_AGENT_DIR: undefined, HOME: "/operator" });
  // The builder's own homedir is `os.homedir()` (Bun-snapshotted), so the unset
  // arm is posed to the function that takes the seam — the same call
  // `buildChildEnv` makes, with the parent env and parent home it would pass.
  const unset = reviewerScratchHomeEnv("explore", childTmp, {}, () => "/operator");
  assert.ok(unset.HOME !== undefined && unset.HOME !== "/operator", "HOME is scratch");
  assert.equal(
    unset[CODING_AGENT_DIR],
    defaultAgentDir("/operator"),
    "with the variable unset the re-export is <parent home>/.pi/agent — the default pi itself would have used before the redirect",
  );
  assert.notEqual(
    unset[CODING_AGENT_DIR],
    defaultAgentDir(unset.HOME ?? ""),
    "and specifically not the scratch path that produced the Unknown-provider death",
  );
  assert.equal(
    unset.PI_AGENT_DIR,
    defaultAgentDir("/operator"),
    "pi-rukas's own name falls back the same way it did before this fix",
  );
  const throughBuilder = buildChildEnv("explore", plan, undefined, childTmp);
  assert.ok(
    CODING_AGENT_DIR in throughBuilder,
    "and the production builder carries the key at all (its default is the process home)",
  );

  console.log("── only a confined role is redirected, so only one gets the re-export ──");
  parentEnv({ [CODING_AGENT_DIR]: pinned });
  for (const role of ["explore", "code-review-specialist", "adversarial-developer"]) {
    const env = buildChildEnv(role, plan, undefined, childTmp);
    assert.equal(env[CODING_AGENT_DIR], pinned, `${role} keeps the parent's config dir`);
    assert.ok(env.HOME?.includes(path.join(childTmp, "home")), `${role}'s HOME is the scratch`);
  }
  for (const role of ["developer", "ops"]) {
    // The ambient value is DELETED for this arm: a non-confined role's env is a
    // copy of the parent's, so with the operator's own workaround exported (this
    // host exports PI_CODING_AGENT_DIR) the key would be present whether or not
    // the redirect ran. Its ABSENCE is what says "no pin added".
    parentEnv({ [CODING_AGENT_DIR]: undefined, PI_AGENT_DIR: undefined });
    const env = buildChildEnv(role, plan, undefined, childTmp);
    assert.equal(
      CODING_AGENT_DIR in env,
      false,
      `${role} is not redirected, so the builder adds no config-dir pin of its own`,
    );
    assert.equal(
      env.HOME,
      process.env.HOME,
      `${role} keeps the inherited HOME verbatim — the builder adds a scratch HOME for a confined role and nothing for this one`,
    );
  }

  console.log("── the pin sits beside the other re-exports, not instead of them ──");
  parentEnv({
    [CODING_AGENT_DIR]: pinned,
    PI_AGENT_DIR: "/operator/rukas-agent",
    PI_ENSEMBLE_SKILLS_DIR: "/operator/skills",
    VIPUNE_DATABASE_PATH: "/operator/vipune.db",
  });
  const all = reviewerScratchHomeEnv("explore", childTmp, { ...process.env }, () => "/operator");
  for (const name of REEXPORTED_HOME_ROOTS) {
    assert.equal(
      all[name],
      {
        PI_CODING_AGENT_DIR: pinned,
        PI_AGENT_DIR: "/operator/rukas-agent",
        PI_ENSEMBLE_SKILLS_DIR: "/operator/skills",
        VIPUNE_DATABASE_PATH: "/operator/vipune.db",
      }[name],
      `${name} is re-exported at the parent's value`,
    );
  }
  assert.ok(
    all.HOME !== undefined && all[CODING_AGENT_DIR] !== undefined &&
      !all[CODING_AGENT_DIR].startsWith(all.HOME),
    "the config dir is never inside the redirected HOME — that is the outage's shape",
  );
} finally {
  parentEnv(saved);
  rmSync(childTmp, { recursive: true, force: true });
}

console.log("\nconfined child / pi config dir (#2368): all groups passed");
