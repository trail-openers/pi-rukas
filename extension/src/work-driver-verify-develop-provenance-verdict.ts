/**
 * work-driver-verify-develop-provenance-verdict — what one candidate's existence answer turns
 * into: a failure, a note, a disclosure, or nothing.
 *
 * Split out of `work-driver-verify-develop-provenance.ts` along the seam between *asking* and
 * *concluding*. The gate module pins one OID, walks the added files and drives the loop; this
 * module takes the single question "does this candidate name a thing that exists" and renders the
 * answer into the gate's three out-channels. The split is where the gate's two hardest invariants
 * live, and a reader checking either should not have to hold the walk beside it:
 *
 *   - **Only an executed `absent` fails.** Every refusal the probe can give — a commit read that
 *     could not answer, a host root it could not read — is a named *could-not-tell*, never a
 *     verdict. Silence is never a pass and never a failure either.
 *   - **Host context is asked BEFORE the bare-token classifier.** `$S/ops/c5-qual` is host
 *     provenance and must reach the PR body with the host-provenance reason, not with the
 *     classifier's words about a character needing quoting: a reader who sees "quote" looks for a
 *     quoting bug, and a reader who sees "host path" looks at their run directory. A fragment that
 *     is not host context then meets the shipped classifier unchanged, which is why a bar-separated
 *     value is disclosed rather than probed as its middle word.
 *
 * Leaf by policy: imports the classifier and the renderers, and reaches git and the filesystem only
 * through the callbacks the gate hands it — so this module cannot widen the gate's dependency graph
 * or read anything the gate did not already decide to read.
 */

import type { DriverContext } from "./work-driver-context.ts";
import type { ProbeVerdict, TreePaths } from "./work-driver-verify-develop-provenance-commit.ts";
import { probeCandidate } from "./work-driver-verify-develop-provenance-commit.ts";
import type { ProvenanceDisclosure } from "./work-driver-verify-develop-provenance-disclosure.ts";
import {
  provenanceAbsentFailure,
  provenanceBasenameDisclosure,
} from "./work-driver-verify-develop-provenance-disclosure.ts";
import { PROVENANCE_NOTE_PREFIX } from "./work-driver-verify-develop-provenance-limits.ts";
import type { HostRootProbe } from "./work-driver-verify-develop-provenance-root.ts";
import { VERIFY_PROVENANCE_ROOT_ENV } from "./work-driver-verify-develop-provenance-root.ts";
import {
  classifyToken,
  code,
  display,
  hostContextProblem,
} from "./work-driver-verify-develop-provenance-token.ts";

/** What judging one candidate produced, so the caller accumulates counts and rows across a file. */
export interface CandidateOutcome {
  /** Did this candidate spend a probe? The workstream's `judged` count is the sum of these, and it
   * is what tells an executed pass from a pass that judged nothing. */
  judged: boolean;
  failures: string[];
  notes: string[];
  disclosures: ProvenanceDisclosure[];
}

/** The reads and the pinned ref one verdict needs, handed down by the gate so this module issues
 * no read of its own and cannot be driven against a ref the gate did not pin first. */
export interface CandidateReads {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cwd: string;
  /** The workstream's pinned head — the only ref any read here may use. */
  oid: string;
  treePaths: TreePaths;
  hostRoot: HostRootProbe;
  /** The prose arm: on, host context is asked first and a bare name is answered by the tree
   * listing; off, the candidate meets the shipped classifier alone and is answered exactly. */
  prose: boolean;
}

/**
 * Judge one candidate: the (key, token) pair the walk offered from one added data file.
 *
 * The ordering inside is the contract, not an implementation detail — host context, then the
 * shipped classifier, then the commit read, then the host root, then the failure. Reordering the
 * last two would fail a record whose author legitimately read from an untracked run directory;
 * reordering the first two would disclose a host path under a reason that sends the operator to the
 * wrong knob.
 */
export async function judgeCandidate(
  reads: CandidateReads,
  file: string,
  key: string,
  token: string,
): Promise<CandidateOutcome> {
  const displayFile = display(file);
  const displayKey = display(key);
  const displayToken = display(token);
  const failures: string[] = [];
  const notes: string[] = [];
  const disclosures: ProvenanceDisclosure[] = [];
  const host = reads.prose ? hostContextProblem(token) : undefined;
  if (host !== undefined) {
    disclosures.push({
      file: displayFile,
      key: displayKey,
      token: displayToken,
      reason: `not a repo-relative path (${host}) — host provenance this gate cannot see`,
    });
    return { judged: false, failures, notes, disclosures };
  }
  const classified = classifyToken(token);
  if (classified.kind === "unverifiable") {
    disclosures.push({
      file: displayFile,
      key: displayKey,
      token: displayToken,
      reason: `not a repo-relative path (${classified.why}) — host provenance this gate cannot see`,
    });
    return { judged: false, failures, notes, disclosures };
  }
  // The tree path a BARE-name claim was satisfied at, when the commit answered it from the
  // whole-tree listing rather than at the path the record spelled out. undefined unless the
  // basename read ran and matched — an exact-path answer says nothing about where the file sits,
  // and a host-root answer is disclosed nowhere because the host root is the operator's own
  // declaration, not a claim the tree supported.
  let matchedVia: string | undefined;
  const verdict: ProbeVerdict = await probeCandidate(
    reads.execFn,
    reads.cwd,
    reads.oid,
    classified.probe,
    reads.treePaths,
    reads.prose,
    (path) => {
      matchedVia = path;
    },
  );
  if (verdict === "unreadable") {
    notes.push(
      `${PROVENANCE_NOTE_PREFIX} could not tell whether ${displayToken} named by ${code(file)}.${displayKey} exists at the pinned commit — not judged`,
    );
    return { judged: true, failures, notes, disclosures };
  }
  if (verdict === "absent") {
    // A claim the commit cannot answer may still be one the project satisfied legitimately: the
    // record's author read the file from a run directory the repository does not track. That is the
    // operator's `PROVENANCE_ROOT` to declare, and consulting it is the ONLY host read this gate
    // makes. An executed `absent` falls through to the failure; an `unusable` root is a named
    // could-not-tell, never a verdict, because a root the gate could not read is not evidence that
    // the file the record cites does not exist.
    const hostVerdict = await reads.hostRoot(classified.probe);
    if (hostVerdict.kind === "present") {
      return { judged: true, failures, notes, disclosures };
    }
    if (hostVerdict.kind === "unusable") {
      // The reason is the root module's own words, and the type leaves it optional: a probe that
      // said `unusable` without saying why is a fault in the probe, not a licence to print
      // "undefined" into the driver log. The fallback names the fault rather than hiding it.
      const why = hostVerdict.why ?? "the probe declined without a reason";
      notes.push(
        `${PROVENANCE_NOTE_PREFIX} could not tell whether ${displayToken} named by ${code(file)}.${displayKey} exists under the declared ${VERIFY_PROVENANCE_ROOT_ENV} (${display(why)}) — not judged`,
      );
      return { judged: true, failures, notes, disclosures };
    }
    failures.push(provenanceAbsentFailure({ file, key, token, oid: reads.oid }));
    return { judged: true, failures, notes, disclosures };
  }
  if (matchedVia !== undefined && matchedVia !== token) {
    // Satisfied by BASENAME, at a path other than the one the record spelled. The renderer names
    // why the row exists; the decision to emit it stays here.
    disclosures.push(
      provenanceBasenameDisclosure({
        file: displayFile,
        key: displayKey,
        token: displayToken,
        satisfiedAt: matchedVia,
      }),
    );
  }
  return { judged: true, failures, notes, disclosures };
}
