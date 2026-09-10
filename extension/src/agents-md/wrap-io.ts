/**
 * wrap-io — the I/O shell for the brownfield `no-markers` wrap (runWrap).
 *
 * Split from agents-md.ts to stay under the 500-line hard limit (§12 AGENTS.md).
 * The wrap's pure logic lives in wrap.ts; this file is the I/O layer that
 * reads the file, computes the sidecar plan, and writes both files.
 */

import type { AgentsMdFs, VerbResult } from "./agents-md.ts";
import { detectFacts } from "./detect.ts";
import { renderLedger } from "./ledger.ts";
import { presentIds } from "./markers.ts";
import { commandsBody, environmentBody, gatesBody, omissionFor } from "./renderer.ts";
import { type OperatorAnswers, computeScaffold, runWrapScaffold } from "./scaffold.ts";
import { type SidecarPlan, sidecarDir, sidecarPath } from "./sidecar.ts";
import { WrapError, isInsertionsOnly, wrapBytes, wrapLedgerRows } from "./wrap.ts";

function parseMarkersSafe(bytes: string): string[] {
  try {
    return presentIds(bytes);
  } catch {
    return [];
  }
}

function omittedSections(
  facts: import("./detect.ts").DetectedFacts,
): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const id of ["quality-gates", "commands", "environment"] as const) {
    const reason = omissionFor(facts, id);
    if (reason) out.push({ id, reason });
  }
  return out;
}

/**
 * The I/O shell for the brownfield wrap. See agents-md.ts for the full
 * design note. Exit codes: ambiguity → 1; reword/delete or nothing
 * classifiable → 2.
 */
export function runWrap(
  root: string,
  file: string,
  fs: AgentsMdFs,
  dryRun: boolean,
  opts?: {
    scaffoldBodies?: { id: string; body: string }[];
    answers?: OperatorAnswers;
  },
): VerbResult {
  const current = fs.readFile(file);
  const facts = detectFacts(root);
  const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);

  const bodies: { id: string; body: string }[] = [];
  const omitted: { id: string; reason: string }[] = [];
  for (const { id, body } of [
    { id: "quality-gates", body: gatesBody(facts) },
    { id: "commands", body: commandsBody(facts) },
    { id: "environment", body: environmentBody(facts) },
  ] as const) {
    if (typeof body === "string") bodies.push({ id, body });
    else omitted.push({ id, reason: body.omit });
  }

  const ledger = wrapLedgerRows(today, omitted);
  let bytes: string;
  try {
    bytes = wrapBytes(current, facts, bodies, ledger, opts?.scaffoldBodies).bytes;
  } catch (e) {
    if (e instanceof WrapError) {
      return {
        verb: "update",
        error: e.message,
        exitCode: /ambiguous classification/.test(e.message) ? 1 : 2,
      };
    }
    throw e;
  }

  if (!isInsertionsOnly(current, bytes)) {
    return {
      verb: "update",
      error: "wrap would reword or delete an original line — refusing",
      exitCode: 2,
    };
  }

  let scaffoldedIds: string[] = [];
  if (opts?.scaffoldBodies) {
    const wrapIds = parseMarkersSafe(bytes);
    const scaffoldResult = computeScaffold(new Set(wrapIds), {
      scaffold: true,
      answers: opts.answers,
    });
    const post = runWrapScaffold(bytes, scaffoldResult);
    if (post.bytes !== bytes) {
      bytes = post.bytes;
      scaffoldedIds = post.scaffoldedIds;
    }
  }

  const sPath = sidecarPath(root);
  const sOld = fs.stat(sPath) ? fs.readFile(sPath) : "";
  const sNew = renderLedger(ledger);
  const sPlan: SidecarPlan = {
    path: sPath,
    oldBytes: sOld,
    newBytes: sNew,
    wouldWrite: sNew !== sOld,
  };

  const wouldWrite = bytes !== current || sPlan.wouldWrite;
  if (wouldWrite && !dryRun) {
    try {
      if (sPlan.wouldWrite) {
        fs.mkdir?.(sidecarDir(root));
        fs.writeFile(sPath, sNew);
      }
      if (bytes !== current) fs.writeFile(file, bytes);
    } catch (err) {
      return {
        verb: "update",
        error: `write FAILED: ${(err as Error).message}`,
        exitCode: 1,
      };
    }
  }
  return {
    verb: "update",
    plan: {
      state: "no-markers",
      newBytes: bytes,
      oldBytes: current,
      wouldWrite,
      managedIds: parseMarkersSafe(bytes),
      scaffoldedIds: scaffoldedIds.length ? scaffoldedIds : undefined,
      omitted: omittedSections(facts),
      sidecar: sPlan,
    },
    exitCode: 0,
  };
}
