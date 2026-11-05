#!/usr/bin/env bun
/**
 * #2031 AC3 (edge) — the errno the "no baseline" line names is the errno the
 * PRE-run listing actually got, not the errno of whatever the guard's second
 * probe happened to hit.
 *
 * The frozen AC3 file produces unreadability with a `chmod 000` that STAYS in
 * place for the whole run, so the listing and the reason-probe both fail EACCES
 * and agree. The interesting case is the one nobody tried: a home the guard
 * cannot list at the start and which becomes listable before the reason is
 * computed. The module computes the reason by RE-RUNNING the listing
 * (`snapshotCode`), and a successful second attempt reports `unknown` — so the
 * operator is handed `could not snapshot $HOME (unknown)` for a home that is
 * sitting there perfectly readable, which is the line that says "the guard could
 * not work out why it could not read your home" for a home it could.
 *
 * "No baseline is not a change" is preserved (no entry is named, `ok` stands);
 * what fails is the reason the line names.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../src/spawn-operator-config.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";

const SELF = "test-AC3-home-snapshot-code-honest.ts";
const realErrWrite = process.stderr.write.bind(process.stderr);
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    realErrWrite(`✗ ${SELF}: ${msg}\n`);
    exit = 1;
  }
}

let errWrites: string[] = [];
process.stderr.write = ((chunk: string | Uint8Array) => {
  errWrites.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
function drainHomeWarns(): string[] {
  const seen = errWrites.flatMap((c) => String(c).split("\n"));
  errWrites = [];
  return seen.filter((l) => l.includes("$HOME"));
}

function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

if (process.getuid === undefined || process.getuid() === 0) {
  console.log("– skipped: running as root, mode 000 is not unreadable");
} else {
  const root = mkdtempSync(path.join(tmpdir(), "pi-2031-ac3-code-"));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "keep.txt"), "operator's own\n");
  // Unreadable for the guard's PRE-run listing only.
  chmodSync(home, 0o000);
  let res: DispatchResult | undefined;
  await withEnv({ HOME: home }, async () => {
    res = await withOperatorConfigGuard("adversarial-developer", async () => {
      // The child makes its own home readable again before the guard computes
      // the reason for the failure it already saw.
      await new Promise((settle) => setTimeout(settle, 5));
      chmodSync(home, 0o755);
      return result();
    });
  });
  chmodSync(home, 0o755);

  const warns = drainHomeWarns();
  const snapshot = warns.filter((l) => l.includes("could not snapshot $HOME"));
  assert(
    snapshot.length === 1,
    `AC3 edge: exactly one "could not snapshot $HOME" warn (${JSON.stringify(warns)})`,
  );
  assert(
    snapshot[0]?.includes("unknown") === false,
    `AC3 edge: the line names the errno the listing actually failed with, not "unknown" for a home the guard could re-read (${JSON.stringify(snapshot[0] ?? "")})`,
  );
  assert(
    (res?.operatorConfig ?? []).every((l) => !l.includes("created in $HOME")),
    `AC3 edge: still no entry named without a baseline (${JSON.stringify(res?.operatorConfig ?? [])})`,
  );
  assert(res?.ok === true, "AC3 edge: the disclosure never changes ok");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
