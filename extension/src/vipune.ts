/**
 * vipune — the single seam between pi-ensemble and the memory CLI.
 *
 * Everything here is calibrated against measurements of the real binary, not
 * against its documentation. Two facts drive the whole design and neither is
 * guessable from the docs:
 *
 *   1. **`--hybrid` scores are Reciprocal Rank Fusion reciprocals (k=25), not
 *      relevance.** A perfect identifier match scores `2/26 = 0.0769` on a
 *      5-row corpus and `0.0769` on a 35-row corpus — identical, because both
 *      are rank 1 in both retrievers. A nonsense query still returns a top row
 *      at `1/26 = 0.0385`. Thresholding a hybrid score is meaningless in
 *      principle, not merely miscalibrated. It carries exactly one usable bit:
 *      *both retrievers ranked this first*.
 *   2. **Pure semantic at `--recency 0.0` does discriminate** (0.772 for a
 *      perfect match vs 0.525 for nonsense) — but the answerable and
 *      unanswerable distributions overlap, so the floor is an operating point
 *      rather than a separator, and it is not sufficient alone.
 *
 * Hence `selectResults`: for guard legs a row must clear the semantic floor
 * **AND** win the hybrid boolean. Measured on three independent corpora, that
 * conjunction is a perfect classifier at zero recall cost, where the floor
 * alone admitted a guard about an unrelated file. A union would be strictly
 * worse than either: it is monotone, so it can only add rows.
 *
 * Upstream issues this works around: randomm/vipune#177 (exit code 2 is
 * overloaded between "conflict detected" and clap usage errors), #178
 * (`memory_type` / `status` are settable and filterable but returned by no
 * command, so a supersede cannot read back the type it must preserve), #179
 * (retrieval telemetry is maintained but unreadable).
 */

import { execFile } from "node:child_process";
import { trace } from "./trace.ts";

/** The closed enum vipune accepts. A typo here is a compile error, not an exit 1. */
export type MemoryType = "fact" | "preference" | "procedure" | "guard" | "observation";
export type MemoryStatus = "active" | "candidate";

export interface MemoryHit {
  id: string;
  content: string;
  /** Cosine for semantic reads; an RRF reciprocal for hybrid ones. Never compare across modes. */
  similarity: number;
}

export type VipuneResult =
  | { kind: "added"; id: string }
  | { kind: "superseded"; id: string }
  | { kind: "conflict"; conflicts: MemoryHit[] }
  | { kind: "absent" }
  | { kind: "refused"; reason: "secret" | "too-long" }
  | { kind: "timeout"; ms: number }
  | { kind: "error"; exitCode: number; detail: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 1000;

/**
 * The semantic floor. An operating point, not a separator — the answerable and
 * unanswerable distributions genuinely overlap around it, which is why guard
 * legs require the hybrid boolean as well.
 */
export const SIM_FLOOR = 0.65;

/**
 * A row scoring at or above this in hybrid mode was ranked first by BOTH
 * retrievers (`1/26 + 1/26`). Anything less was ranked first by at most one.
 * This is a boolean dressed as a number; never treat it as a magnitude.
 */
export const HYBRID_AGREEMENT = 0.075;

/**
 * Secrets we refuse to store. vipune persists plaintext SQLite.
 *
 * Deliberately keyed on *shape with context*, never on raw entropy. An
 * earlier draft used `[A-Fa-f0-9]{40,}`, which matches every git SHA — so a
 * correction citing a commit, or a CI error line containing a hash, would
 * have been silently refused on the highest-value write path.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{12,}/i,
  // A password embedded in a URL: scheme://user:pass@host
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/**
 * Is this query shaped like a code identifier, so a hybrid sibling leg is
 * meaningful?
 *
 * BM25 fires on sub-tokens and stopwords, so the agreement bit false-fires on
 * degenerate input — measured: `ts` → 0.0769, `never` → 0.0742, `the` →
 * 0.0697, all indistinguishable from a real match. Requiring a single whole
 * token of length ≥ 5 carrying a dot, hyphen or capital removes that class.
 */
export function isIdentifierShaped(query: string): boolean {
  const q = query.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{4,}$/.test(q)) return false;
  return /[.\-A-Z]/.test(q);
}

type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        reject(Object.assign(e, { stdout: String(stdout), stderr: String(stderr) }));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface VipuneOpts {
  /** REQUIRED. Always the repo root — never `process.cwd()`, never a worktree. */
  cwd: string;
  timeoutMs?: number;
  binary?: string;
  execFn?: ExecFn;
}

/**
 * Classify a non-zero exit.
 *
 * Exit 2 is overloaded (vipune#177): a genuine conflict writes
 * `{"status":"conflicts",…}` to **stdout**, while a clap usage error writes
 * nothing to stdout and its message to stderr. Keying on the exit code alone
 * makes the driver read its own argv bug as a memory conflict — and the
 * documented response to a conflict is to supersede or `--force`, which would
 * write garbage. So: discriminate on stdout, always.
 */
function classifyFailure(exitCode: number, stdout: string, stderr: string): VipuneResult {
  if (exitCode === 2) {
    try {
      const parsed = JSON.parse(stdout) as { status?: string; conflicts?: MemoryHit[] };
      if (parsed.status === "conflicts") {
        return { kind: "conflict", conflicts: parsed.conflicts ?? [] };
      }
    } catch {
      // Not JSON — fall through. This is the argv-error branch.
    }
    return {
      kind: "error",
      exitCode: 2,
      detail: `usage error (not a conflict): ${stderr.trim().slice(0, 200)}`,
    };
  }
  return { kind: "error", exitCode, detail: (stderr || stdout).trim().slice(0, 200) };
}

/** Store one atomic memory. Never `--force`: see the module header. */
export async function vipuneAdd(
  text: string,
  opts: VipuneOpts & {
    memoryType: MemoryType;
    status?: MemoryStatus;
    /**
     * When set, `memoryType` must be the ORIGINAL memory's type. vipune#178
     * makes the stored type unreadable, so a supersede that guesses wrong
     * silently retypes — e.g. a `guard` becomes a `fact` and is thereafter
     * invisible to every guard-filtered read, unrecoverably. Callers resolve
     * the type by static leg priority, never by which leg scored highest.
     */
    supersedes?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<VipuneResult> {
  if (text.length > MAX_CONTENT_CHARS) return { kind: "refused", reason: "too-long" };
  if (looksLikeSecret(text)) {
    trace("vipune: refused a write that looks like a secret (never reached the binary)");
    return { kind: "refused", reason: "secret" };
  }
  const args = ["add", text, "--memory-type", opts.memoryType, "--json"];
  if (opts.status) args.push("--status", opts.status);
  if (opts.supersedes) args.push("--supersedes", opts.supersedes);
  if (opts.metadata) args.push("-m", JSON.stringify(opts.metadata));
  const r = await run(args, opts);
  if ("failure" in r) return r.failure;
  try {
    const parsed = JSON.parse(r.stdout) as { status?: string; id?: string };
    if (parsed.id) {
      return parsed.status === "superseded"
        ? { kind: "superseded", id: parsed.id }
        : { kind: "added", id: parsed.id };
    }
  } catch {
    // fall through
  }
  return { kind: "error", exitCode: 0, detail: "add succeeded but returned no id" };
}

export interface SearchOpts extends VipuneOpts {
  memoryType?: MemoryType;
  limit?: number;
  hybrid?: boolean;
  /**
   * Left here to make the prohibition explicit and testable. No compiled path
   * may pass a non-zero value: the composite is
   * `(1-r)*cosine + r*2^(-ageDays/8)`, so any threshold calibrated on cosine
   * breaks the moment recency is mixed in, and a 90-day-old perfect match
   * falls out of a `--limit 5` window by r≈0.4. Sort on `created_at` in TS
   * instead — `search --json` already returns it.
   */
  recency?: 0;
}

export type SearchResult =
  | { kind: "hits"; hits: MemoryHit[] }
  | { kind: "absent" }
  | { kind: "timeout"; ms: number }
  | { kind: "error"; detail: string };

export async function vipuneSearch(query: string, opts: SearchOpts): Promise<SearchResult> {
  if (opts.hybrid && (opts.recency ?? 0) !== 0) {
    // RRF's whole top-10 spread is ~0.048 while the recency term spans r*1.0,
    // so any non-zero recency simply re-sorts by age and discards relevance.
    throw new Error("vipune: --hybrid with a non-zero --recency is a recency sort, not a search");
  }
  const args = ["search"];
  args.push(opts.hybrid ? "--hybrid" : "--no-hybrid");
  args.push("--recency", "0.0", "--limit", String(opts.limit ?? 5), "--no-touch", "--json");
  if (opts.memoryType) args.push("--memory-type", opts.memoryType);
  // `--` last, so a query beginning with a dash is not parsed as a flag.
  // Reachable in production: retrieval keyed on a raw compiler error line.
  // Note `search -- "<query>" --limit 3` does NOT work — `--` makes every
  // later token positional — so the flags must come first.
  args.push("--", query);
  const r = await run(args, opts);
  if ("failure" in r) {
    const f = r.failure;
    if (f.kind === "absent" || f.kind === "timeout") return f;
    return { kind: "error", detail: f.kind === "error" ? f.detail : f.kind };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { results?: MemoryHit[] };
    return { kind: "hits", hits: parsed.results ?? [] };
  } catch {
    return { kind: "error", detail: "search returned unparseable stdout" };
  }
}

async function run(
  args: string[],
  opts: VipuneOpts,
): Promise<{ stdout: string } | { failure: VipuneResult }> {
  const exec = opts.execFn ?? defaultExec;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await exec(opts.binary ?? "vipune", args, {
      cwd: opts.cwd,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT") return { failure: { kind: "absent" } };
    if (e.killed) return { failure: { kind: "timeout", ms: timeout } };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    return { failure: classifyFailure(exitCode, e.stdout ?? "", e.stderr ?? e.message ?? "") };
  }
}

/**
 * Decide which retrieved rows are worth injecting into an agent's prompt.
 *
 * `requireAgreement` is the guard-leg rule and is a **conjunction**, not a
 * union. Measured on three independent corpora of guards each naming a
 * distinct source file:
 *
 *   floor 0.65 alone     → 5/5 positives, 1/5 negatives  (injects the wrong guard)
 *   agreement alone      → 5/5 positives, 0/5 negatives
 *   AND of both          → 5/5 positives, 0/5 negatives
 *
 * The floor cannot separate these on its own for a structural reason: every
 * guard in a pi-ensemble store is *about a pi-ensemble filename*, so any
 * plausible basename is semantically near all of them. Cosine cannot tell
 * "this guard is about THIS file" from "about SOME file in this project";
 * BM25 can, because it only ranks a row first on a literal token match.
 *
 * A union would be strictly worse than either input: it is monotone, so it can
 * only add rows and can never remove the floor's false positive.
 */
export function selectResults(
  semantic: MemoryHit[],
  hybrid: MemoryHit[] | undefined,
  opts: { requireAgreement: boolean },
): MemoryHit[] {
  const passedFloor = semantic.filter((h) => h.similarity >= SIM_FLOOR);
  if (!opts.requireAgreement) return passedFloor;
  if (!hybrid) return [];
  const agreed = new Set(hybrid.filter((h) => h.similarity >= HYBRID_AGREEMENT).map((h) => h.id));
  return passedFloor.filter((h) => agreed.has(h.id));
}

/**
 * The brief injected into a subagent prompt.
 *
 * Framed as hypotheses on purpose. A retrieved memory is a claim about a
 * codebase that has since changed, and an agent that treats it as fact will
 * confidently act on a stale one — the failure mode the corpus calls
 * stale-fact citation. The id is carried so the agent can cite it back as
 * evidence, which is what makes the correction path possible at all.
 */
export function renderBrief(hits: MemoryHit[], heading = "Prior memory"): string {
  if (hits.length === 0) return "";
  return [
    `## ${heading} — HYPOTHESES, verify against the code before acting on any of them`,
    "",
    ...hits.slice(0, 10).map((h) => `- [vipune:${h.id}] [unverified] ${h.content}`),
    "",
    "If you check one and the code disagrees, say so in your Evidence block with",
    "`vipune:<id>` as the source — do not silently ignore a memory you found to be wrong.",
  ].join("\n");
}
