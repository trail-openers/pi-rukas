#!/usr/bin/env bun
/**
 * Headless S6 (#1021) — `pi-rukas-headless plan` drives the real /plan
 * pipeline with stub dispatch and a stub forge (no model call, no issue
 * created) and maps its result to the exit code and JSON document:
 *
 *   --dry-run           → 0, the spec, nothing filed
 *   --file              → 0, `url` from the forge
 *   too-thin descriptor → 11, `questions`, zero dispatches, nothing filed
 *   duplicate risk high → 10, the rationale, nothing filed
 *   forge create error  → 40, failure.reason "create-error"
 *   bad arguments       → 40, error.code "bad-arguments", nothing dispatched
 */

import { makeAssert, runVerb } from "./headless-verb-harness.ts";
import {
  DESC,
  DUP_NONE,
  GAP_HIGH,
  REPO,
  forgeStub,
  installCountingDispatch,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  log,
  setPlanDispatch,
} from "./plan-test-stubs.ts";

const { assert, state } = makeAssert();
installNoPlanCacheStub();
installOfflineVipuneStub();
installForgeStub();

function reset(dup = DUP_NONE) {
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  installCountingDispatch(GAP_HIGH, dup);
}

{
  reset();
  const r = await runVerb("plan", [DESC, "--dry-run", "--json"], REPO);
  assert(r.violations.length === 0, `dry run: output contract (${r.violations.join("; ")})`);
  assert(r.code === 0, `dry run exits 0 (got ${r.code})`);
  assert(r.doc.status === "dry-run" && r.doc.mode === "dry-run", "dry run: status and mode");
  assert(typeof r.doc.spec === "string" && (r.doc.spec as string).length > 0, "dry run: spec");
  assert(r.doc.filed === false && r.doc.url === undefined, "dry run: not filed, no url");
  assert(forgeStub.created.length === 0, "dry run: the forge was never called");
  assert(log.explore > 0, "dry run: the pipeline really ran (explore dispatched)");
}

{
  reset();
  const r = await runVerb("plan", [DESC, "--file"], REPO);
  assert(r.violations.length === 0, `file: output contract (${r.violations.join("; ")})`);
  assert(r.code === 0, `file exits 0 (got ${r.code})`);
  assert(r.doc.status === "filed" && r.doc.filed === true, "file: status filed");
  assert(r.doc.url === "https://github.com/test/test/issues/1", "file: url from the forge");
  assert(forgeStub.created.length === 1, "file: exactly one issue created");
}

{
  reset();
  const r = await runVerb("plan", ["fix login bug", "--dry-run"], REPO);
  assert(r.violations.length === 0, `clarification: output contract (${r.violations.join("; ")})`);
  assert(r.code === 11, `needs-clarification exits 11 (got ${r.code})`);
  assert(r.doc.status === "needs-clarification", "clarification: status");
  const q = r.doc.questions as string[] | undefined;
  assert(Array.isArray(q) && q.length > 0, "clarification: the questions are in the JSON");
  assert(
    (r.doc.failure as { reason?: string })?.reason === "needs-clarification",
    "clarification: failure.reason",
  );
  assert(log.explore === 0 && log.gate === 0, "clarification: zero dispatches");
  assert(forgeStub.created.length === 0, "clarification: nothing filed");
}

{
  reset("DUPLICATE_RISK: high — duplicates #5 which is still open");
  const r = await runVerb("plan", [DESC, "--file"], REPO);
  assert(r.violations.length === 0, `duplicate: output contract (${r.violations.join("; ")})`);
  assert(r.code === 10, `duplicate-risk exits 10 (got ${r.code})`);
  assert(r.doc.status === "duplicate-risk", "duplicate: status");
  assert(String(r.doc.spec).includes("duplicates #5"), "duplicate: the rationale is in the JSON");
  assert(log.gate === 0, "duplicate: the gap gate never ran");
  assert(forgeStub.created.length === 0, "duplicate: nothing filed");
}

{
  reset();
  forgeStub.mode = "throw";
  const r = await runVerb("plan", [DESC, "--file"], REPO);
  assert(r.violations.length === 0, `create-error: output contract (${r.violations.join("; ")})`);
  assert(r.code === 40, `create-error exits 40 (got ${r.code})`);
  const f = r.doc.failure as { reason?: string; detail?: string } | undefined;
  assert(f?.reason === "create-error" && !!f.detail, "create-error: failure.reason and detail");
}

for (const argv of [[DESC], [DESC, "--dry-run", "--file"], [DESC, "--dry-run", "--merge"], []]) {
  reset();
  const r = await runVerb("plan", argv, REPO);
  assert(
    r.code === 40 && (r.doc.error as { code?: string })?.code === "bad-arguments",
    `bad arguments [${argv.slice(1).join(" ")}] → 40 bad-arguments`,
  );
  assert(log.explore === 0 && log.gate === 0, "bad arguments: nothing dispatched");
}

setPlanDispatch(null);
process.exit(state.exit);
