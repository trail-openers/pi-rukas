/**
 * work-driver-verify-report-file — #1404: read a verify run's failing-test
 * names from the channel a test cannot write.
 *
 * The commit-pr baseline probe excuses a failing test when the SAME test also
 * fails at the cycle's base commit. It used to get those names by parsing the
 * run's combined stdout+stderr, which any test can write to. `failingTestNames`
 * in `work-driver-verify-names.ts` already refuses a stream whose `FAILED:`
 * summary disagrees with its own per-file markers or its `P:/F:` tally — but
 * that defence is per-shape. A test that prints the whole **triad** at once — a
 * per-file `FAILED: <path>`, a count-matched `FAILED: 1 test(s) — <path>`
 * summary, and a non-zero `P:/F:` tally — is byte-for-byte what the loop emits,
 * so it is indistinguishable from the loop's own verdict. A base run that is
 * actually GREEN then appears to name the change's failure, the change-caused
 * failure is excused, and the cycle PUSHES. Anchoring names to the probe root
 * does not help (a forged name can sit under it), and `probed` is derived from
 * the same stream, so it is not an independent signal.
 *
 * So the names move channels. The loop writes its own verdict to the file named
 * by `VERIFY_REPORT_FILE` (extension/smoke-tests/lib/verify-report-file.sh),
 * after all tests finish, and scrubs the variable from every test child
 * (`env -u` at the single `bun run` in verify-kill.sh) so a test cannot learn
 * the path. This module is the ONLY reader of that file on the driver side, and
 * it reads nothing else: the stream can no longer excuse anything.
 *
 * FAIL-CLOSED IS THE WHOLE MODULE. Every shape that is not a complete, coherent
 * report is a named `reason` and the caller parks — which is exactly the
 * behaviour this seam had before #1404, so a project whose verify command is
 * not this loop loses nothing: no report, no excuse, park.
 */

import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * A name carrying any control character is not a path the loop recorded from
 * its argv. The class is ASSEMBLED from code points rather than written as a
 * regex literal with the bytes in it — the same shape `plan-provenance.ts` uses
 * for the reason given there: the set is identical either way, the literal is
 * what biome's `noControlCharactersInRegex` flags, and suppressing a rule that
 * exists to catch a mistyped control byte is the bypass AGENTS.md forbids.
 * `String.fromCharCode` keeps the bytes out of the source (no invisible
 * character for a formatter to replace) while each code point stays readable
 * against this comment, and a malformed class throws at module load rather than
 * silently matching nothing.
 */
const CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/** The trailer the loop writes as its final line: `FAILED-TESTS: <count>`. */
const TRAILER_RE = /^FAILED-TESTS: ([0-9]+)$/;

/** The per-file marker the loop prints to the STREAM — never into a name. */
const PER_FILE_MARKER_PREFIX = "FAILED:";

/** The tally line the loop prints to the STREAM — never into a name. */
const TALLY_RE = /^P: [0-9]+ {2}F: [0-9]+$/;

/**
 * A report is bounded by what the loop can print: one path per line, and the
 * suite is on the order of a few hundred files. A file far past that is not a
 * report — it is something else at that path — and a reader that scans
 * unbounded input is a memory story the gate does not need.
 */
const MAX_REPORT_BYTES = 1_000_000;

/** Every name a report may carry before the reader stops trusting it. */
const MAX_REPORT_NAMES = 5_000;

/**
 * The outcome of reading one report file.
 *
 * `names` is set ONLY on a complete, coherent read. Every other shape carries
 * `reason` — never an empty list, because an empty list means "the run named
 * nothing", which is a real answer, while a failure to read means "we do not
 * know", which must never be conflated with it.
 */
export interface VerifyReport {
  /** The failing test paths, in the order the loop recorded them. */
  names?: string[];
  /** Why no verdict could be read. Set whenever `names` is absent. */
  reason?: string;
}

/**
 * Parse a report body. Pure — the I/O is `readVerifyReport` — so the fail-closed
 * rules are testable without a filesystem.
 *
 * Rules, each of which is a park:
 *
 * - the last line must be the `FAILED-TESTS: <n>` trailer, exactly once, and
 *   match the fixed shape (a count a test invented by writing text is caught by
 *   the disagreement rules below, not by trusting the number);
 * - the lines before it are the names, and must be non-empty, free of control
 *   characters, and not themselves look like trailer/summary/tally markers (a
 *   name that IS a marker means the body is not the loop's list);
 * - the name count must equal the trailer's count;
 * - zero names is a legitimate all-pass report and yields `names: []`;
 * - anything else — no trailer, a malformed trailer, a count that disagrees, an
 *   empty body, an absurdly large body — is unattributable.
 */
export function parseVerifyReport(body: string): VerifyReport {
  if (body === "") {
    return {
      reason:
        "the verify report file was empty, so the loop recorded no verdict (a run killed before its report half leaves exactly this)",
    };
  }
  if (body.length > MAX_REPORT_BYTES) {
    return {
      reason: `the verify report file was larger than ${MAX_REPORT_BYTES} bytes, which no honest name list reaches — it is not the loop's report`,
    };
  }
  const lines = body.split("\n");
  // A trailing newline (the loop writes one) leaves an empty final element; it
  // is formatting, not a name.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    return { reason: "the verify report file contained no lines at all" };
  }
  const trailerIndex = lines.length - 1;
  const trailer = TRAILER_RE.exec(lines[trailerIndex] ?? "");
  if (trailer === null) {
    return {
      reason:
        "the verify report file's last line was not the loop's `FAILED-TESTS: <count>` trailer, so it is not a verdict the loop wrote",
    };
  }
  const claimed = Number(trailer[1]);
  if (!Number.isSafeInteger(claimed) || claimed < 0) {
    return { reason: "the verify report file's count was not a non-negative integer" };
  }
  // A trailer anywhere but at the end means the body is not what the loop
  // writes — the loop emits names first and the count last, exactly once.
  for (let i = 0; i < trailerIndex; i++) {
    if (TRAILER_RE.test(lines[i] ?? "")) {
      return {
        reason:
          "the verify report file carried its count trailer somewhere other than the final line, so the file was not written by the loop's single report pass",
      };
    }
  }
  const nameLines = lines.slice(0, trailerIndex);
  if (claimed === 0 && nameLines.length !== 0) {
    return {
      reason: `the verify report file claimed 0 failing tests but listed ${nameLines.length} name(s)`,
    };
  }
  if (claimed > MAX_REPORT_NAMES) {
    return {
      reason: `the verify report file claimed ${claimed} failing tests, past the ${MAX_REPORT_NAMES} a suite can produce`,
    };
  }
  if (nameLines.length !== claimed) {
    return {
      reason: `the verify report file listed ${nameLines.length} failing test path(s) but its own trailer counted ${claimed} — a list and a count that disagree are not the loop's verdict`,
    };
  }
  const names: string[] = [];
  for (const raw of nameLines) {
    const name = raw.trim();
    if (name === "") {
      return { reason: "the verify report file listed an empty line where a test path belongs" };
    }
    if (CONTROL_CHAR_RE.test(name)) {
      return {
        reason: "the verify report file listed a test path carrying a control character",
      };
    }
    // A "name" that is itself one of the loop's stream markers means the body
    // was assembled rather than emitted — the loop never puts a `FAILED:` or a
    // `P:/F:` line in the name list.
    if (name.startsWith(PER_FILE_MARKER_PREFIX) || TRAILER_RE.test(name) || TALLY_RE.test(name)) {
      return {
        reason:
          "the verify report file's name list contained one of the loop's own verdict markers, which the loop never writes into a name",
      };
    }
    names.push(name);
  }
  return { names };
}

/**
 * Read and parse one report file. Every failure to read — missing, unreadable,
 * a directory, a symlink to something odd — is a named `reason`, never a
 * fallback to the stream.
 *
 * The file is opened with `O_NOFOLLOW` where the platform offers it and read
 * through the descriptor, so a report path swapped for a symlink after the
 * driver created it does not turn the reader into an arbitrary-file reader. The
 * driver keeps the parent directory 0700 and creates the file itself, so this
 * is belt-and-braces against a same-user race rather than the primary defence.
 */
export function readVerifyReport(path: string): VerifyReport {
  let fd: number;
  try {
    // `O_NOFOLLOW` is not defined on every platform bun exposes; the fallback
    // keeps the reader working, and the 0700 parent is what actually protects
    // the path.
    const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | nofollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      reason:
        code === "ENOENT"
          ? "no verify report file exists at the path the driver created — the project's verify command is not this repo's smoke loop, or the run never reached its report half, so nothing can be attributed"
          : `the verify report file could not be opened (${String(code ?? (err as Error).message)})`,
    };
  }
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_REPORT_BYTES) {
      return {
        reason: `the verify report file was ${size} bytes, past the ${MAX_REPORT_BYTES} an honest name list reaches`,
      };
    }
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return parseVerifyReport(buffer.toString("utf8", 0, read));
  } catch (err) {
    return {
      reason: `the verify report file could not be read: ${String((err as Error).message)}`,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is gone or was never valid; nothing to clean up.
    }
  }
}
