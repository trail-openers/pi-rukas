#!/usr/bin/env bun
/**
 * Smoke test for per-role tool-gating (PR #238 — Option A).
 *
 * Asserts the exclude-tools map for each role:
 *  - read-only roles (explore, adversarial-developer, code-review-specialist)
 *    have write/edit/multiedit excluded
 *  - executor roles (developer, ops) have NO exclusions
 *  - PM (rarely spawned as subagent) has NO exclusions (gating lives elsewhere
 *    for the parent process; see role-tools.ts header comment)
 *  - excludeToolsFor returns undefined for empty lists so spawn.ts can skip
 *    the flag entirely
 *  - unknown roles get no exclusions (err open, not closed)
 */

import { excludeToolListFor, excludeToolsFor } from "../src/role-tools.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. Read-only roles get write/edit/multiedit excluded.
{
  for (const role of ["explore", "adversarial-developer", "code-review-specialist"]) {
    const list = excludeToolListFor(role);
    assert(list.includes("write"), `${role}: write excluded`);
    assert(list.includes("edit"), `${role}: edit excluded`);
    assert(list.includes("multiedit"), `${role}: multiedit excluded`);
    const csv = excludeToolsFor(role);
    assert(csv === "write,edit,multiedit", `${role}: CSV shape correct (got: ${csv})`);
  }
}

// 2. Executor roles (developer, ops) have NO exclusions.
{
  for (const role of ["developer", "ops"]) {
    const list = excludeToolListFor(role);
    assert(list.length === 0, `${role}: empty exclude list (developer/ops legitimately need write/edit)`);
    const csv = excludeToolsFor(role);
    assert(csv === undefined, `${role}: excludeToolsFor returns undefined (spawn.ts skips the flag)`);
  }
}

// 3. project-manager (rarely a subagent) has NO exclusions — gating lives
//    elsewhere for the parent process; see role-tools.ts header comment.
{
  const list = excludeToolListFor("project-manager");
  assert(list.length === 0, "project-manager: empty exclude list (parent-process gating is separate concern)");
  const csv = excludeToolsFor("project-manager");
  assert(csv === undefined, "project-manager: excludeToolsFor returns undefined");
}

// 4. Unknown role: err open. Better to omit the flag than to break a future
//    role we haven't added to the map.
{
  const list = excludeToolListFor("future-role-that-does-not-exist");
  assert(list.length === 0, "unknown role: empty exclude list");
  const csv = excludeToolsFor("future-role-that-does-not-exist");
  assert(csv === undefined, "unknown role: excludeToolsFor returns undefined (errs open)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
