/**
 * git-oid-read — the ONE `git rev-parse` read that turns a ref into an object id.
 *
 * Before this module each ref-to-OID site carried its own `rev-parse` argv, and
 * three of them carried `--end-of-options`. That flag is a terminator for
 * `log`/`diff`/`rev-list` on any git, but `rev-parse` is git's own option
 * parser: a git that does not recognise it in that subcommand **echoes the
 * literal** on stdout ahead of the object id and still exits 0. Every reader of
 * that stdout then rejects the answer it was given — the merge-time
 * protected-path gate holds the landing, the ref probe reports "could not tell",
 * the push scan refuses. On such a host the failure is total, not intermittent.
 *
 * The flag was there to stop a ref that begins with `-` being parsed as an
 * option. It does that job no better than a caller that refuses the ref itself,
 * and it costs a whole class of host, so the refusal lives HERE and the flag is
 * gone: every site is guarded whatever its caller forgot to check.
 *
 * `test-git-rev-parse-no-end-of-options-canary.ts` fails the suite if the flag
 * returns to a `rev-parse` argv anywhere in `src/`.
 *
 * A LEAF by design: it imports no project module and takes the caller's own
 * executor, so a module that needs an OID read does not acquire this repo's
 * exec seam (or, through it, the driver) as a dependency, and the scripted
 * fakes that answer a site's git calls answer this read too.
 */

/** The executor seam every caller already injects, narrowed to what this read uses. */
export type OidExec = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; argv?: string[] },
) => Promise<{ stdout: string; stderr?: string }>;

/** A ref that reads as an option would be parsed as one; refused, never passed to git. */
function leadingDashProblem(ref: string): string | undefined {
  return ref.startsWith("-") ? `ref "${ref.slice(0, 60)}" begins with "-"` : undefined;
}

/** What one ref-to-OID read asks git, and how strictly it judges the answer. */
export interface OidReadOptions {
  /**
   * Peel suffix appended to the ref with the git `^{…}` syntax: `commit`,
   * `tree`, or omitted for the object the ref names itself. Peeling is what
   * makes `<tag>^{commit}` refuse to answer as anything but the commit it points at.
   */
  peel?: "commit" | "tree";
  /**
   * Pass `--quiet`. `false` (the default) keeps git's stderr and exit code,
   * which is the only evidence a caller has for "git itself said that ref is not
   * there" as opposed to "git could not be asked"; it also keeps git's exit 128
   * where `--quiet` would report 1.
   */
  quiet?: boolean;
  /**
   * The shape a successful stdout must have, judged on `stdout.trim()`. A git
   * that printed anything beside the id fails a `{40,64}`-hex predicate and a
   * single-line predicate alike. Each caller keeps the predicate it has always
   * accepted — widening one changes how it classifies a missing ref.
   */
  accept: (trimmed: string) => boolean;
  /** Milliseconds on the git call. */
  timeoutMs: number;
  /** Byte ceiling on stdout — an OID read answers one line. */
  maxBuffer?: number;
}

/** A git answer that is not the object id asked for, naming the answer and why. */
export type OidReadFailure = {
  kind: "refused" | "odd-output";
  problem: string;
};

/**
 * `git rev-parse [--verify] [--quiet] <ref>[^{peel}]` → the object id git printed.
 *
 * `ok` carries the trimmed stdout, which has passed `accept`. `refused` means
 * the call was never issued (a ref beginning with `-`). `odd-output` covers
 * both a non-zero exit and an answer that failed `accept` — a shim, a wrapper,
 * or a git printing a warning instead of an id all exit 0 while naming no
 * object, and reading that as resolved is the bug this read exists to stop.
 *
 * A rejection carrying NO exit information at all — no `code`, no `killed`, no
 * `signal` — is not git refusing, it is an executor that could not be called or
 * that refused the call it was handed. That re-throws rather than becoming a
 * verdict: a scripted fake that throws on an unscripted argv must fail the test
 * loudly, which is the only way an argv-shape drift is caught.
 *
 * A failed call carries the executor's own rejection fields (`code`, `killed`,
 * `signal`, `stderr`) through on `cause`, so a caller that reads git's exit
 * code and wording to tell "git itself said that ref is not there" from "git
 * could not be asked" does so from this one call rather than issuing a second;
 * `problem` is the human-readable fallback for a caller with no such question.
 */
export type OidRead =
  | { ok: true; oid: string }
  | {
      ok: false;
      kind: OidReadFailure["kind"];
      problem: string;
      /** The executor's rejection, when the read failed before git answered. */
      cause?: unknown;
    };

export async function readCommitOid(
  exec: OidExec,
  cwd: string,
  ref: string,
  opts: OidReadOptions,
): Promise<OidRead> {
  const bad = leadingDashProblem(ref);
  if (bad) return { ok: false, kind: "refused", problem: bad };
  const argv = [
    "rev-parse",
    "--verify",
    ...(opts.quiet ? ["--quiet"] : []),
    opts.peel ? `${ref}^{${opts.peel}}` : ref,
  ];
  let stdout = "";
  try {
    const out = await exec("git", {
      argv,
      cwd,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 8 * 1024,
    });
    stdout = out.stdout;
  } catch (err) {
    const e = err as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      stderr?: unknown;
      message?: unknown;
    } | null;
    // Nothing here says a process ran and answered. Let it propagate.
    if (e?.code === undefined && e?.killed === undefined && e?.signal === undefined) {
      throw err;
    }
    const text = typeof e?.stderr === "string" ? e.stderr : "";
    return {
      ok: false,
      kind: "odd-output",
      problem: `git ${argv.join(" ")} failed: ${text.trim() || (typeof e?.message === "string" ? e.message : String(err))}`,
      cause: err,
    };
  }
  const oid = stdout.trim();
  if (!opts.accept(oid)) {
    return {
      ok: false,
      kind: "odd-output",
      problem: `printed ${JSON.stringify(oid.slice(0, 40))}, not an object id`,
    };
  }
  return { ok: true, oid };
}
