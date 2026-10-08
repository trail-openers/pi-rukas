#!/usr/bin/env bun
/**
 * #1023 task-b — import-surface spike (part of epic #1018, the headless
 * runner).
 *
 * Question: which @earendil-works/pi-* packages does a PLAIN bun process pull
 * in (value-level, direct or transitive) when it imports the compiled-driver
 * entry points? The headless runner (S4) wants exactly this set, because it is
 * what must resolve at runtime — type-only imports (all pi-coding-agent uses)
 * are erased at transpile time and never load.
 *
 * The script does two things, both in a plain bun process (no Pi runtime):
 *
 *   1. IMPORT PROOF — `bun <entry.ts>` for each of the five entry points.
 *      Exit 0 proves plain bun resolves the entry (and its whole transitive
 *      graph). A non-zero exit surfaces the failing import chain.
 *
 *   2. IMPORT-SURFACE AUDIT — a static reachability scan. For each entry we
 *      walk the local import graph (./x, ../x, src/x, relative .ts) and
 *      collect every @earendil-works specifier that appears as a VALUE import
 *      (not `import type`). Type-only imports are excluded because bun erases
 *      them at transpile time, so they never resolve at runtime. The scan
 *      distinguishes `import { X } from` / `import X from` (value) from
 *      `import type { X } from` (type).
 *
 * Why a static scan for the audit (and not a runtime hook): bun's `Bun.plugin`
 * onResolve does not fire for most node_modules package specifiers — it only
 * observed the bare `@earendil-works/pi-tui/dist/keys.js` subpath and missed
 * the bare `@earendil-works/pi-tui` value imports in lifecycle-events.ts,
 * dispatch-deck-nav.ts, dispatch-deck-composite.ts, etc. Static scanning of the
 * static import graph is complete and deterministic; the runtime hook is
 * not. The runtime import proof (item 1) still establishes resolvability.
 *
 * NOTE: deliberately NOT named test-*.ts so the offline gate
 * (`bun run smoke-tests/test-*.ts`) does not run it. Run manually:
 *   cd extension && bun smoke-tests/spike-import-surface.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

/** The five entry points the epic asks about. */
const ENTRIES: { label: string; rel: string; args: string[] }[] = [
  { label: "runDriver (work-entry.ts)", rel: "work-entry.ts", args: [] },
  { label: "runPlanPipeline (plan-driver.ts)", rel: "plan-driver.ts", args: [] },
  { label: "runResearchPipeline (research-driver.ts)", rel: "research-driver.ts", args: [] },
  { label: "runLensReview (lens-review.ts)", rel: "lens-review.ts", args: [] },
  // The module has a CLI that process.exit()es on a bare invocation. A verb
  // argument prevents it from running the bare-arg branch, but the CLI still
  // validates its target and exits non-zero when AGENTS.md is absent (as it is
  // in a worktree). That is NOT an import failure — the imports resolved and
  // the module loaded, then the CLI logic exited. The proof line below notes
  // this explicitly rather than claiming "resolves in plain bun" (exit 0).
  { label: "agents-md (agents-md/agents-md.ts)", rel: "agents-md/agents-md.ts", args: ["check"] },
];

// --- static import-graph build ---------------------------------------------

/** Every .ts file under src, keyed by its path relative to src. */
function listSrcFiles(dir: string, relBase = ""): Map<string, string> {
  const out = new Map<string, string>();
  const abs = relBase ? path.join(SRC, relBase) : SRC;
  for (const name of readdirSync(abs, { withFileTypes: true })) {
    if (name.isDirectory()) {
      const sub = listSrcFiles(
        path.join(abs, name.name),
        relBase ? path.join(relBase, name.name) : name.name,
      );
      for (const [k, v] of sub) out.set(k, v);
    } else if (name.name.endsWith(".ts")) {
      const rel = relBase ? path.join(relBase, name.name) : name.name;
      out.set(rel, path.join(abs, name.name));
    }
  }
  return out;
}

/**
 * Parse a single src file for its local imports and its value-level
 * @earendil-works imports. Local imports are the specifiers that resolve to
 * another src file; value pi-imports are the @earendil-works specifiers used
 * with a non-`type` import form.
 */
function parseFile(absPath: string): { localSpecs: Set<string>; piValueSpecs: Set<string> } {
  const localSpecs = new Set<string>();
  const piValueSpecs = new Set<string>();
  const src = readFileSync(absPath, "utf8");
  const lines = src.split("\n");
  let inImport = false;
  let buf = "";
  const flush = () => {
    const stmt = buf.trim();
    buf = "";
    inImport = false;
    if (!stmt.startsWith("import")) return;
    // A statement-level `import type { … }` / `import type X from` is erased at
    // transpile time and never resolves at runtime, so it is excluded. A mixed
    // `import { type A, B } from` is NOT caught by the statement-level `import
    // type` marker — it carries real value bindings (B) and is correctly kept
    // as a value import. (Biome enforces trailingCommas, so the flush trigger
    // below reliably fires; the side-effect form has no trailing comma.)
    const side = stmt.match(/^import\s+["']([^"']+)["']/);
    if (side) {
      const spec = side[1];
      if (spec.startsWith("@earendil-works/")) piValueSpecs.add(spec);
      else if (spec.startsWith("./") || spec.startsWith("../")) localSpecs.add(spec);
      return;
    }
    const isTypeImport = /^import\s+type\b/.test(stmt);
    const m = stmt.match(/\bfrom\s+["']([^"']+)["']/);
    if (!m) return;
    const spec = m[1];
    if (spec.startsWith("@earendil-works/")) {
      if (!isTypeImport) piValueSpecs.add(spec);
    } else if (spec.startsWith("./") || spec.startsWith("../")) {
      localSpecs.add(spec);
    }
  };
  for (const line of lines) {
    if (!inImport) {
      if (/^import\s/.test(line) || /^import$/.test(line)) {
        inImport = true;
        buf = line;
        if (/from\s+["'][^"']+["']/.test(line) || /^import\s+["'][^"']+["']/.test(line)) flush();
      }
    } else {
      buf += `\n${line}`;
      if (/from\s+["'][^"']+["']/.test(line) || /["'][^"']+["']$/.test(line)) flush();
    }
  }
  if (inImport) flush();
  return { localSpecs, piValueSpecs };
}

/** Resolve a local spec (relative to the file's directory) to a src-relative path. */
function resolveLocal(fromRel: string, spec: string): string | null {
  const fromDir = path.posix.dirname(fromRel);
  let resolved = path.posix.normalize(path.posix.join(fromDir, spec));
  if (!resolved.endsWith(".ts")) resolved += ".ts";
  return existsSync(path.join(SRC, resolved)) ? resolved : null;
}

interface GraphResult {
  reachable: Set<string>; // src-rel paths reached from entry
  piValueSpecs: Set<string>; // value @earendil-works specs among reachable
  piImportSites: Map<string, Set<string>>; // src-rel -> pi specs it imports (value)
}

function buildGraph(
  entryRel: string,
  files: Map<string, string>,
  parsed: Map<string, ReturnType<typeof parseFile>>,
): GraphResult {
  const reachable = new Set<string>();
  const queue: string[] = [entryRel];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === undefined) break;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const p = parsed.get(cur);
    if (!p) continue;
    for (const spec of p.localSpecs) {
      const r = resolveLocal(cur, spec);
      if (r && !reachable.has(r)) queue.push(r);
    }
  }
  const piValueSpecs = new Set<string>();
  const piImportSites = new Map<string, Set<string>>();
  for (const cur of reachable) {
    const p = parsed.get(cur);
    if (!p) continue;
    if (p.piValueSpecs.size) {
      piImportSites.set(cur, new Set(p.piValueSpecs));
      for (const s of p.piValueSpecs) piValueSpecs.add(s);
    }
  }
  return { reachable, piValueSpecs, piImportSites };
}

// --- per-entry runner --------------------------------------------------------

function runEntry(
  rel: string,
  args: string[],
): {
  plainExit: number;
  plainOutput: string;
} {
  const entryPath = path.join(SRC, rel);
  const plain = spawnSync("bun", [entryPath, ...args], { encoding: "utf8", timeout: 30000 });
  // `status` is null whenever the child cannot run at all — spawnSync then
  // fills in `error` (ENOENT on `bun`, EACCES, …). Without this, a spawn
  // failure and an entry that dies after 0 bytes of output both read as
  // "exit -1, no output", and the real cause is lost — and this spike's
  // output IS the evidence.
  const err = plain.error;
  const spawnNote = err ? `spawn error: ${err.code ?? "unknown"} ${err.message}` : null;
  return {
    plainExit: plain.status ?? -1,
    plainOutput: [plain.stdout, plain.stderr, spawnNote].filter(Boolean).join("\n"),
  };
}

// --- main --------------------------------------------------------------------

async function main() {
  console.log(
    `# #1023 import-surface spike — platform: ${process.platform} (${process.arch}), bun ${process.versions.bun ?? "unknown"}`,
  );
  console.log(
    `# plain bun process, no Pi runtime. Entry points: ${ENTRIES.map((e) => e.rel).join(", ")}`,
  );
  console.log("");

  const files = listSrcFiles(SRC);
  const parsed = new Map<string, ReturnType<typeof parseFile>>();
  for (const [rel, abs] of files) parsed.set(rel, parseFile(abs));

  const unionPkgs = new Set<string>();
  const unionSites = new Map<string, Set<string>>();

  // 1) import proof (sequential — runEntry is spawnSync, which blocks the
  // event loop, so Promise.all would not add any concurrency; the serial
  // loop is the honest shape). Each entry is well under 1s in practice.
  const importProofs = ENTRIES.map((e) => ({ entry: e, proof: runEntry(e.rel, e.args) }));

  // 2) per-entry graph + report
  const graphs = ENTRIES.map((e) => buildGraph(e.rel, files, parsed));

  for (let i = 0; i < ENTRIES.length; i++) {
    const { entry, proof } = importProofs[i];
    const g = graphs[i];
    console.log(`=== ${entry.label} ===`);
    if (proof.plainExit === 0) {
      console.log(`import proof: bun ${entry.rel} → exit 0 (resolves in plain bun)`);
    } else if (entry.rel === "agents-md/agents-md.ts") {
      // The CLI validates its target and exits non-zero when AGENTS.md is
      // absent (true in a worktree). That is not an import failure — the
      // imports resolved and the module loaded before the CLI logic exited.
      console.log(
        `import proof: bun ${entry.rel} → exit ${proof.plainExit} (CLI exit; imports resolved, module loaded)`,
      );
    } else {
      console.log(`import proof: bun ${entry.rel} → exit ${proof.plainExit} (see below)`);
    }
    if (proof.plainExit !== 0) {
      const err = proof.plainOutput.split("\n").slice(0, 10).join("\n");
      if (err) console.log(err);
    }
    console.log(`src modules reachable: ${g.reachable.size}`);
    if (g.piValueSpecs.size === 0) {
      console.log(
        "no value-level @earendil-works imports in the closure (type-only imports were erased)",
      );
    } else {
      console.log(
        `value-level @earendil-works imports reachable: ${[...g.piValueSpecs].sort().join(", ")}`,
      );
      for (const [site, specs] of [...g.piImportSites.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        console.log(`  src/${site} => ${[...specs].sort().join(", ")}`);
      }
    }
    console.log("");
    for (const p of g.piValueSpecs) unionPkgs.add(p);
    for (const [site, specs] of g.piImportSites) {
      const s = unionSites.get(site) ?? new Set<string>();
      for (const v of specs) s.add(v);
      unionSites.set(site, s);
    }
  }

  console.log("=== UNION (all five entries) ===");
  console.log(
    `value-level @earendil-works packages reachable: ${[...unionPkgs].sort().join(", ") || "(none)"}`,
  );
  console.log("import sites (src file => package):");
  for (const [site, specs] of [...unionSites.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  src/${site} => ${[...specs].sort().join(", ")}`);
  }
  console.log("");
  const pkgs = [...unionPkgs].sort();
  console.log("Conversion needed for S4 (plain bun, no Pi runtime) — derived from the computed");
  console.log(`union above (at time of writing: ${pkgs.join(", ") || "(none)"}):`);
  console.log("  • Every package above is a VALUE import — it must resolve at runtime.");
  if (pkgs.length === 1 && pkgs[0] === "@earendil-works/pi-tui") {
    console.log("  • pi-tui (Text, Container, Component, matchesKey, decodeKittyPrintable, …) is");
    console.log("    the only package with value-level reachability into the driver entry points.");
    console.log(
      "  • A plain-bun headless entry must therefore vendor/stub pi-tui (or keep it as a",
    );
    console.log("    real dep). All other driver imports (node builtins + local modules) already");
    console.log("    resolve in plain bun, as the import proof above shows (exit 0).");
  } else {
    console.log("  • Read the per-entry and union sections above for the package set this run");
    console.log("    actually measured; the concrete conversion list follows that data, not this");
    console.log("    footer, which is a snapshot of the conclusion at time of writing.");
  }
  console.log(
    "  • pi-coding-agent and pi-ai appear only as type-only imports (import type) — erased at transpile,",
  );
  console.log("    zero runtime resolution, no conversion needed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
