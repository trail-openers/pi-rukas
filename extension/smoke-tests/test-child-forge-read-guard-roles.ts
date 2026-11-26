#!/usr/bin/env bun
/**
 * test-child-forge-read-guard-roles.ts — the #2638 arms that judge WHO the rule
 * applies to, and whether it is the rule doing the work.
 *
 * Split out of `test-child-forge-read-guard.ts` (which carries the read/copy/tool/
 * env/symlink forms) along the seam between "what a call names" and "who is
 * refused": the three groups here read the ROLE and the protected SET, not the
 * command text, and the mutant arm is the file that makes every refusal row in
 * both files mean something.
 *
 *   G  the ops exemption, and the missing-role arm (fails closed, decision 12);
 *   H  the passwd-home canary: a path the fixture's env never named, which only
 *      the parent's passwd entry produces — the row that proves the guard judged a
 *      path OUTSIDE the fixture home (decision 14), reached by BOTH its spellings;
 *   I  the mutant: the same rows with the judge stood down, each observed RED.
 *
 * The driver (`lib/forge-read-guard-driver.ts`) is what keeps the two files
 * asking the same question of the same hook.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { assert, exit } from "./lib/assert-rig.ts";
import { withEnv } from "./lib/env-scope.ts";
import { type Row, dirsFor, judge } from "./lib/forge-read-guard-driver.ts";
import {
  PASSWD_CANARY_SENTINEL,
  buildForgeFixture,
  forgeParentEnv,
} from "./lib/forge-read-protected-fixture.ts";

// ============================================================
// G — the ops exemption, and the role that is absent.
// ============================================================
{
  const fx = buildForgeFixture("roles");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  // ops is exempt: the same command it must be able to run, run by ops, is not refused.
  const asOps = await judge(`cat ${ghFile}`, dirs, { role: "ops" });
  assert(
    asOps === undefined,
    "G/ops: `cat` of the gh credential file is NOT refused — the role that keeps its login works",
  );
  const opsRead = await judge(["read", { path: ghFile }], dirs, { role: "ops" });
  assert(
    opsRead === undefined,
    "G/ops: the read tool is not refused either (ops can read and write the forge)",
  );
  // And ops is exempt WITHOUT a protected set in its env: registration stands down
  // before the set is asked, so an ops dispatch that carries no set still works.
  const opsNoSet = await judge(`cat ${ghFile}`, undefined, { role: "ops" });
  assert(
    opsNoSet === undefined,
    "G/ops without a protected set: not refused (the exemption is checked first)",
  );
  // Every other role, and NO role at all, is judged.
  for (const role of [
    "developer",
    "code-review-specialist",
    "adversarial-developer",
    "explore",
    "project-manager",
    "lens-fix",
    "some-unroled-child",
    undefined,
    "",
  ]) {
    const r = await judge(`cat ${ghFile}`, dirs, { role });
    assert(
      r?.block === true,
      `G/${role === undefined ? "<absent role>" : role === "" ? "<empty role>" : role}: refused (only ops is exempt — the rule fails closed)`,
    );
  }
}

// ============================================================
// H — the passwd-home canary: a path OUTSIDE the fixture home.
// ============================================================
{
  const fx = buildForgeFixture("passwd");
  // The parent's env names ONLY the operator home — every home-derived spelling is
  // built from `envHome`, so `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` stay out of this
  // row. The canary then lives under the fixture's SECOND home, at a name no
  // variable in that env produces: a guard that resolved the home from the child, or
  // that protected only what the env named, never reaches it.
  const env = { HOME: fx.home, XDG_CONFIG_HOME: fx.xdg };
  const dirs = dirsFor(env, fx.passwdHome);
  assert(
    !dirs.some((d) => d.lexical.startsWith(fx.passwdHome + path.sep)) === false,
    "H: the passwd home is a protected root in its own right",
  );
  // (i) the TYPED spelling, under the passwd home, through its `.config` link.
  const typed = await judge(`cat ${fx.canaryTypedFile}`, dirs);
  assert(
    typed?.block === true && !(typed.reason ?? "").includes(PASSWD_CANARY_SENTINEL),
    "H/typed: reading the passwd-home credential file is refused, and its sentinel never reaches the reason",
  );
  // (ii) the RESOLVED spelling, which lies OUTSIDE the protected home. Deleting the
  // realpath arm of the matcher and this row goes red.
  const resolved = await judge(`cat ${fx.canaryLinkedFile}`, dirs);
  assert(
    resolved?.block === true && !(resolved.reason ?? "").includes(PASSWD_CANARY_SENTINEL),
    "H/resolved: the same file reached by its realpath is refused too (the link is followed, not trusted)",
  );
  assert(
    !fx.canaryLinkedFile.startsWith(fx.passwdHome + path.sep),
    "H/precondition: the resolved spelling really does lie outside the protected home",
  );
  // The child's own HOME is re-pointed at the operator home, and the read is still
  // refused: the set the guard judges is the parent's, not the child's env's.
  await withEnv({ HOME: fx.home }, async () => {
    const inside = await judge(`cat ${fx.canaryTypedFile}`, dirs);
    assert(
      inside?.block === true,
      "H/child HOME re-pointed: the passwd-home read is still refused",
    );
  });
  // A path that is merely SIBLING to the passwd home is not caught by it.
  const sibling = path.join(path.dirname(fx.passwdHome), "notes.txt");
  writeFileSync(sibling, "not a credential\n");
  const near = await judge(`cat ${sibling}`, dirs);
  assert(
    near === undefined,
    "H/sibling: a file beside the passwd home is not the passwd home's config",
  );
}

// ============================================================
// I — the mutant: every group above is observed RED with the hook stand-down.
// ============================================================
{
  const fx = buildForgeFixture("mutant");
  const dirs = dirsFor(forgeParentEnv(fx), fx.passwdHome);
  const ghFile = fx.ghFiles[1] as string;
  const glabFile = fx.glabFiles[0] as string;
  // The stand-down: the same registration, with the judge's path set emptied —
  // what the rule would be without the protected set. Every refusal row above is
  // vacuous if THIS set of rows goes green: a gate never seen red proves nothing.
  const rows: Row[] = [
    `cat ${ghFile}`,
    `grep token ${glabFile}`,
    `cp ${ghFile} /tmp/x`,
    `install ${glabFile} /tmp/x`,
    `tar czf /tmp/a.tgz -C ${fx.glab} .`,
    `dd if=${glabFile} of=/tmp/x`,
    `sh < ${ghFile}`,
    `python3 -c 'open("${ghFile}")'`,
    ["read", { path: glabFile }],
    ["read", { path: fx.gh }],
  ];
  let passed = 0;
  let firstHeld: string | undefined;
  for (const row of rows) {
    const r = await judge(row, dirs, { standDown: true });
    if (r === undefined) passed++;
    else if (firstHeld === undefined) firstHeld = JSON.stringify(r.reason ?? "").slice(0, 140);
  }
  assert(
    passed === rows.length,
    `I/mutant: with the guard's protected set emptied every one of the ${rows.length} rows runs (so the refusal rows above prove the rule, not the fixture) — ${passed} ran; first held: ${firstHeld ?? "none"}`,
  );
  const live = await judge(`cat ${ghFile}`, dirs);
  assert(
    live?.block === true,
    "I/mutant control: with the set in place the same command is refused (the difference IS the rule)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);

console.log(`\nexit ${exit}`);
process.exit(exit);
