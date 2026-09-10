/**
 * update-agent — the update verb for AGENTS.md.
 *
 * Reads the current file, parses markers, rebuilds managed sections from
 * project facts, runs the scaffold post-pass, and writes the new bytes back.
 * Exported as a closure with injected deps to avoid circular imports.
 */

import type { AgentsMdFs } from "./agents-md.ts";
import { detectExistingBoilerplate } from "./boilerplate-detect.ts";
import { type DetectedFacts, detectFacts } from "./detect.ts";
import {
  type LedgerRow,
  driftWarnings,
  mergeAutoRows,
  mergeOmissionRows,
  parseLedger,
  renderLedger,
  upsertRow,
} from "./ledger.ts";
import { parseInFileLedger } from "./legacy-ledger.ts";
import { codeStyleBody, commandsBody, environmentBody, gatesBody } from "./renderer.ts";
import {
  type AgentOverride,
  type ScaffoldOpts,
  computeScaffold,
  runScaffoldPostPass,
} from "./scaffold.ts";
import type { OperatorAnswers } from "./scaffold.ts";
import {
  appendManagedSection,
  findManagedSections,
  insertManagedSectionAfter,
  presentManagedIds,
  removeInFileLedgerBody,
  spliceManagedSection,
  stripLegacyMarkers,
} from "./section-detect.ts";
import { type SidecarPlan, sidecarDir, sidecarPath } from "./sidecar.ts";

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const DEFAULT_FS: AgentsMdFs = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, b) => writeFileSync(p, b),
  stat: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  today: () => new Date().toISOString().slice(0, 10),
};

// ------------------------------------------------------------------ types

/** Verb-result for update — no check payload. */
interface UpdateVerbResult {
  verb: "update";
  plan?: import("./agents-md.ts").Plan;
  error?: string;
  exitCode: number;
}

/** Type for the createAgent function passed as dependency. */
type CreateAgentFn = (
  root: string,
  file: string,
  fs: AgentsMdFs,
  opts: ScaffoldOpts | boolean,
  dryRunParam?: boolean,
) => import("./agents-md.ts").VerbResult;

/** Type for the runWrap function passed as dependency. */
type RunWrapFn = (
  root: string,
  file: string,
  fs: AgentsMdFs,
  dryRunParam: boolean,
  opts?: {
    scaffoldBodies?: { id: string; body: string }[];
    answers?: OperatorAnswers;
    agentOverride?: AgentOverride;
  },
) => import("./agents-md.ts").VerbResult;

/** Type for the omissionRows helper passed as dependency. */
type OmissionRowsFn = (facts: DetectedFacts, today: string) => LedgerRow[];

// ------------------------------------------------------------------ update verb

/**
 * The update verb: reads the current file, rebuilds managed sections, runs
 * scaffold, and writes back if changed.
 */
export function makeUpdateAgent(
  createAgentFn: CreateAgentFn,
  runWrapFn: RunWrapFn,
  omissionRowsFn: OmissionRowsFn,
): (
  root: string,
  file: string,
  fs?: AgentsMdFs,
  opts?: ScaffoldOpts | boolean,
  dryRunParam?: boolean,
) => UpdateVerbResult {
  return function updateAgent(
    root: string,
    file: string,
    fs: AgentsMdFs = DEFAULT_FS,
    opts: ScaffoldOpts | boolean = {},
    dryRunParam?: boolean,
  ): UpdateVerbResult {
    // Handle legacy 4-positional call: updateAgent(root, file, fs, true)
    // where `true` was dryRun.
    let effectiveOpts: ScaffoldOpts;
    let effectiveDryRun: boolean;
    if (typeof opts === "boolean") {
      effectiveOpts = {};
      effectiveDryRun = opts;
    } else {
      effectiveOpts = opts;
      effectiveDryRun = dryRunParam ?? false;
    }

    // --- determine file state ---
    let state: "no-file" | "has-markers" | "no-markers";
    if (!fs.stat(file)) {
      state = "no-file";
    } else {
      try {
        // Post-#681 M2: discriminate on managed HEADINGS (with the legacy
        // marker strip as tiebreaker), not on marker presence. A file with ≥1
        // managed heading — or with no heading but a legacy marker line that
        // post-strip resolves to one — takes the heading-splice path (strip +
        // re-anchor + splice). A file with neither is brownfield → wrap.
        const raw = fs.readFile(file);
        const stripped = stripLegacyMarkers(raw);
        // A legacy (pre-migration) file is one whose managed marker lines
        // survive the strip (the strip removed pi-rukas/pi-ensemble marker
        // lines from it). A file with neither managed headings nor managed
        // marker lines is a true brownfield file → the wrap path.
        const hadManagedMarkerLines =
          stripped !== raw && /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:/.test(raw);
        state =
          presentManagedIds(stripped).length > 0 || hadManagedMarkerLines
            ? "has-markers"
            : "no-markers";
      } catch {
        state = "has-markers"; // corrupt → treat as has-markers; verb will refuse
      }
    }

    if (state === "no-file") {
      return createAgentFn(root, file, fs, effectiveOpts, effectiveDryRun) as UpdateVerbResult;
    }

    if (state === "no-markers") {
      // True brownfield → the wrap path. (The legacy-marker case is
      // has-markers by construction: the discrimination above routes a file
      // whose marker lines survive the strip to the heading-splice path.)
      const scaffoldBodies: { id: string; body: string }[] = [];
      if (effectiveOpts.scaffold) {
        // Threads agentOverride (incl. testingNotes) through so the wrap's
        // second computation (with wrapped ids as existing) re-renders only
        // sections wrapBytes didn't emit — first-time population, idempotent.
        const scaffoldResult = computeScaffold(new Set(), {
          scaffold: true,
          answers: effectiveOpts.answers,
          agentOverride: effectiveOpts.agentOverride,
        });
        for (const s of scaffoldResult.sections) scaffoldBodies.push({ id: s.id, body: s.body });
      }
      return runWrapFn(root, file, fs, effectiveDryRun, {
        scaffoldBodies: scaffoldBodies.length ? scaffoldBodies : undefined,
        answers: effectiveOpts.answers,
        agentOverride: effectiveOpts.agentOverride,
      }) as UpdateVerbResult;
    }

    // --- has-markers path ---
    const current = fs.readFile(file);

    // Post-#681 M2 migration: a legacy file that still carries HTML-comment
    // markers (and no managed headings yet) is first reduced by the one-pass
    // strip. The strip removes only the marker/`:managed` comment lines and
    // preserves every other byte (including the in-file decision-ledger table,
    // which M1 later migrates to the sidecar). The heading pipeline below then
    // re-anchors the now-markerless spans by their (re-emitted) headings.
    const stripped = stripLegacyMarkers(current);

    let parsed: string[];
    try {
      parsed = presentManagedIds(stripped);
    } catch (e) {
      return {
        verb: "update",
        error: `refusing to update corrupt managed sections: ${(e as Error).message}`,
        exitCode: 2,
      };
    }

    const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);

    // Post-#680 M1: the decision-ledger lives in the sidecar, not the in-file
    // span. A pre-M1 repo that still has an in-file decision-ledger section
    // is MIGRATED on this first update: its rows are read once, merged into
    // the sidecar rows, and the section is removed from the file. A corrupt
    // in-file ledger (malformed row) refuses the update (exit 2) — the same
    // refuse-or-die semantics as a corrupt sidecar.
    const inFileLedgerSpan = parseInFileLedger(stripped);
    if (inFileLedgerSpan.kind === "corrupt") {
      return {
        verb: "update",
        error: "refusing to update corrupt markers: decision-ledger has a malformed row",
        exitCode: 2,
      };
    }

    const sPath = sidecarPath(root);
    const sExists = fs.stat(sPath);
    let existingLedger: LedgerRow[] = [];
    let sOld = "";
    if (inFileLedgerSpan.rows.length > 0) {
      // Migration: pre-M1 repo with an in-file decision-ledger span. Read the
      // sidecar too (if present) and merge both into a single row set.
      if (sExists) {
        try {
          const sidecarRows = parseLedger(fs.readFile(sPath));
          // Merge in-file rows over sidecar rows (sidecar rows win on key
          // collision — the sidecar is the newer store). In practice the
          // in-file rows are a subset the sidecar already has, or they are
          // rows the sidecar does not yet know about. Use upsertRow semantics:
          // for each in-file row, upsert it into the sidecar row list.
          let merged: LedgerRow[] = [...sidecarRows];
          for (const row of inFileLedgerSpan.rows) merged = upsertRow(merged, row);
          existingLedger = merged;
        } catch {
          // Corrupt sidecar alongside a valid in-file ledger: prefer the
          // in-file rows (they are the legacy store); the sidecar will be
          // overwritten with the in-file rows on write.
          existingLedger = inFileLedgerSpan.rows;
        }
      } else {
        existingLedger = inFileLedgerSpan.rows;
      }
      sOld = sExists ? fs.readFile(sPath) : "";
    } else if (sExists) {
      try {
        existingLedger = parseLedger(fs.readFile(sPath));
        sOld = fs.readFile(sPath);
      } catch {
        return {
          verb: "update",
          error: "refusing to update: decision-ledger sidecar is corrupt",
          exitCode: 2,
        };
      }
    }

    // The B1↔B2 seam: when `agentOverride.facts` is supplied, the three fact
    // sections are built from it via the EXISTING gatesBody/commandsBody/
    // environmentBody functions INSTEAD of a fresh detectFacts(). The resulting
    // section rows get [detected:agent,<today>] provenance. When absent, fall
    // back to detectFacts(root) exactly as before.
    const agentOverride: AgentOverride | undefined = effectiveOpts.agentOverride;
    const useOverride = agentOverride?.facts !== undefined;
    const facts = useOverride ? (agentOverride.facts as DetectedFacts) : detectFacts(root);

    // Fact-derived bodies for managed sections.
    const updates = new Map<string, string>();
    const omitted: { id: string; reason: string }[] = [];
    for (const [id, body] of [
      ["quality-gates", gatesBody(facts)],
      ["commands", commandsBody(facts)],
      ["environment", environmentBody(facts)],
    ] as const) {
      if (typeof body === "string") updates.set(id, body);
      else omitted.push({ id, reason: body.omit });
    }

    // The code-style section (agent-derived, plain bullets — it has no
    // omission concept, so it is never added to `omitted`).
    const codeStyleOut = agentOverride?.codeStyleBullets
      ? codeStyleBody(agentOverride.codeStyleBullets)
      : undefined;
    if (codeStyleOut !== undefined) updates.set("code-style", codeStyleOut);

    // Build the body splices FIRST (no ledger yet). This gives us the
    // post-update file bytes that the omission re-derivation below uses.
    // Post-#681 M2: the splice is heading-based — each managed section is
    // re-rendered under its (re-emitted) heading, preserving the heading line
    // and every byte outside the section. The code-style section is inserted
    // explicitly after the environment heading (first-time insertion, Item 2).
    //
    // After the one-pass strip, a legacy file's fact sections may have no
    // heading (the markers carried the boundary, not a heading line). Re-emit
    // the missing headings for sections we are about to splice (from `updates`)
    // so the splice can re-anchor them. This is the heading re-anchoring the
    // migration requires (the strip deliberately does not synthesise headings).
    let currentBytes = stripped;
    let spans = findManagedSections(currentBytes);
    const presentIds = new Set(spans.map((s) => s.id));
    // Re-emit headings for fact sections in `updates` that lack a heading.
    // (The decision-ledger and code-style are handled separately below.)
    for (const id of ["quality-gates", "commands", "environment"].reverse()) {
      if (presentIds.has(id)) continue;
      if (!updates.has(id)) continue;
      const body = updates.get(id) ?? "";
      const targetId =
        id === "quality-gates" ? undefined : id === "commands" ? "quality-gates" : "commands";
      currentBytes = targetId
        ? insertManagedSectionAfter(currentBytes, id, body, targetId)
        : appendManagedSection(currentBytes, id, body);
      presentIds.add(id);
    }
    spans = findManagedSections(currentBytes);
    let bytes = currentBytes;
    // Splice in the SAME order the sections appear in the file: splice
    // re-detects spans on the bytes it was given, so splicing an EARLIER
    // section after a later one would re-detect it under the later section's
    // (larger) span and silently eat its body.
    for (const span of [...spans].sort((a, b) => a.headingLine - b.headingLine)) {
      // The decision-ledger is not a managed heading section (it is a sidecar
      // post-M1, or a legacy in-file span M1 migrates) — never re-emit it here.
      const body = updates.get(span.id);
      if (body === undefined) continue;
      bytes = spliceManagedSection(bytes, span.id, body);
    }

    // First-time code-style insertion: the splice loop above only REWRITES
    // sections already present in the file. When code-style content is
    // supplied but the file has no existing code-style section, explicitly
    // insert it after the environment section (the same primitive the scaffold
    // post-pass uses). Absent bullets → no section, no omission row.
    if (codeStyleOut !== undefined && !spans.some((s) => s.id === "code-style")) {
      bytes = insertManagedSectionAfter(bytes, "code-style", codeStyleOut, "environment");
    }

    // --- Merge ledger. ---
    const FACT_IDS = ["quality-gates", "commands", "environment"] as const;
    // The `auto` parameter to mergeAutoRows is the omission rows for the
    // NON-detected ids. The filter is the Item-4 omission suppression (the
    // churn-loop fix): it keys off the EXISTING ledger's provenance for the
    // section id itself — an id that already carries a [detected:agent] row
    // has its omit:<id> row dropped so it is never re-stamped with today's
    // date. This is what makes a routine update on a no-manifest fixture
    // (whose ledger already carries [detected:agent] rows from a prior
    // agentOverride call) upsert ZERO omit:* rows, even across a date
    // rollover. The filter keys off the section id (quality-gates /
    // commands / environment), NEVER off the omit:<id> rows (auto-provenance
    // by construction — filtering those would be a no-op).
    const detectedAgentIds = new Set(
      existingLedger.filter((r) => r.provenance === "detected").map((r) => r.key),
    );
    const auto = omissionRowsFn(facts, today).filter(
      (r) => !detectedAgentIds.has(r.key.slice("omit:".length)),
    );
    let merged = mergeAutoRows(existingLedger, auto);

    // Item 5 (refresh) + Item 3 (first-time population). For each fact section
    // that agentOverride is writing (a body, not an omission): with
    // refresh:true the [detected:agent] row is DIRECTLY replaced (bypassing
    // mergeAutoRows' sticky rule, which would otherwise keep the old row when
    // the value is unchanged); without refresh the row is populated only for
    // ids that do NOT yet carry a [detected:agent,...] row. Sections that are
    // [auto,...] or [asked,...] are NEVER touched (provenance checked before
    // acting). A no-op — new body byte-identical (post trailing-newline
    // normalisation) to the existing section — keeps the existing row and its
    // date (no churn).
    if (useOverride) {
      for (const id of FACT_IDS) {
        const body = updates.get(id);
        if (body === undefined) continue; // omitted → no detected row
        const spliceForm = body.endsWith("\n") ? body : `${body}\n`;
        const existing = existingLedger.find((r) => r.key === id);
        const isDetected = existing?.provenance === "detected";
        if (effectiveOpts.refresh === true) {
          if (!isDetected) continue; // refresh only touches [detected:agent] rows
          // The stored body carries the blank-line-after-heading separator by
          // convention (section-detect.ts) — compare both normalised shapes.
          const stored = (
            findManagedSections(stripped).find((s) => s.id === id)?.body ?? ""
          ).replace(/^\n/, "");
          const sameValue =
            (stored.endsWith("\n") ? stored : `${stored}\n`) === spliceForm || stored === body;
          if (sameValue) continue; // byte-identical → keep row + date, no churn
          merged = upsertRow(merged, {
            key: id,
            value: "agent",
            provenance: "detected",
            date: today,
          });
        } else if (!isDetected && existing?.provenance === undefined) {
          // First-time population: id has no existing ledger row at all.
          merged = upsertRow(merged, {
            key: id,
            value: "agent",
            provenance: "detected",
            date: today,
          });
        }
        // else: an existing [auto] row (rich manifest) or [detected] row
        // without refresh is left alone — first-time-only, never overwrite.
      }
    }

    // Add the omission rows for ids that are NOT agent-detected (Item 4
    // suppression). The `omitted` array (built from the agentOverride facts
    // when supplied) is filtered to exclude any id that has a [detected:agent]
    // row — the operator is not told a section is omitted when it is
    // agent-derived. The plan's `omitted` field reflects the same filter.
    const omittedForLedger = omitted.filter((o) => !detectedAgentIds.has(o.id));
    merged = mergeOmissionRows(merged, omittedForLedger, today);
    const drift = driftWarnings(existingLedger, auto);

    // Post-#680 M1: the ledger is NOT spliced back into the file — the merged
    // rows are written to the sidecar below. A pre-M1 in-file decision-ledger
    // span is migrated on this first update: its rows were read above and
    // merged into the sidecar rows, and the now-legacy markdown table body
    // (orphaned after the one-pass strip removed its marker lines) is
    // removed from the file so it is not left behind as stray table text in
    // the heading-based file. A purely heading-based file has no table to
    // remove (removeInFileLedgerBody is a byte-identical no-op then).
    if (inFileLedgerSpan.kind === "ok") {
      bytes = removeInFileLedgerBody(bytes);
    }

    // Scaffold post-pass: detect boilerplate headings for idempotency.
    const existingIds = new Set(parsed);
    for (const id of detectExistingBoilerplate(current)) existingIds.add(id);
    let scaffoldedIds: string[] = [];
    if (effectiveOpts.scaffold) {
      // agentOverride carries the testingNotes supplement (first-time
      // population only — computeScaffold skips the section if present).
      const scaffoldResult = computeScaffold(existingIds, {
        scaffold: true,
        answers: effectiveOpts.answers,
        agentOverride: effectiveOpts.agentOverride,
      });
      const post = runScaffoldPostPass(bytes, scaffoldResult, true);
      if (post.bytes !== bytes) {
        bytes = post.bytes;
        scaffoldedIds = post.scaffoldedIds;
        for (const id of post.scaffoldedIds) existingIds.add(id);
      }
    }

    // Sidecar write plan.
    const sNew = renderLedger(merged);
    const sPlan: SidecarPlan = {
      path: sPath,
      oldBytes: sOld,
      newBytes: sNew,
      wouldWrite: sNew !== sOld,
    };

    // wouldWrite: true when EITHER file would change.
    const scaffoldAdded = scaffoldedIds.length > 0;
    const fileWouldWrite = bytes !== stripped;
    const wouldWrite = effectiveOpts.scaffold
      ? scaffoldAdded || fileWouldWrite || sPlan.wouldWrite
      : fileWouldWrite || sPlan.wouldWrite;

    if (wouldWrite && !effectiveDryRun) {
      try {
        if (sPlan.wouldWrite) {
          fs.mkdir?.(sidecarDir(root));
          fs.writeFile(sPath, sNew);
        }
        if (fileWouldWrite) fs.writeFile(file, bytes);
      } catch (err) {
        return { verb: "update", error: `write FAILED: ${(err as Error).message}`, exitCode: 1 };
      }
    }

    return {
      verb: "update",
      plan: {
        state,
        newBytes: bytes,
        oldBytes: stripped,
        wouldWrite,
        managedIds: parsed,
        omitted: omittedForLedger.map((o) => ({ id: o.id, reason: o.reason })),
        drift: drift.length
          ? drift.map((d) => `${d.key}: "${d.asked}" → derives "${d.derived}"`).join("; ")
          : undefined,
        scaffoldedIds: scaffoldedIds.length ? scaffoldedIds : undefined,
        sidecar: sPlan,
      },
      exitCode: 0,
    };
  };
}
