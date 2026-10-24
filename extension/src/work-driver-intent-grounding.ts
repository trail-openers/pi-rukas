/**
 * work-driver-intent-grounding — an `already-implemented` park must name a mainline commit (#1351).
 *
 * "Already implemented" is a claim about the mainline, and nothing checked it
 * there. In one measured case the resolver recorded that main had no trace of the
 * feature, that the work existed only on an open, conflicting PR, and then
 * parked `already-implemented` — so the cycle stopped on a claim its own
 * evidence refuted, and the one actionable fact (the open PR) never surfaced.
 *
 * The prompt asks a resolver that parks this way for `IMPLEMENTED-AT: <sha>`,
 * the mainline commit that did the work. This module checks it with git:
 *
 *   - the commit is an ancestor of `origin/<mainline>` → grounded, unchanged;
 *   - the commit is not on the mainline (an open PR's or a branch's head, or
 *     not in the clone at all) → refuted. An actionable spec proceeds with the
 *     refutation recorded as an assumption, and the branch step's open-PR
 *     preflight (#362) names the PR if one carries the work. A spec with
 *     nothing to build stays parked, as `underspecified`;
 *   - no marker, or a mainline that cannot be read → unchanged and traced.
 *     A stated park is overturned only by positive evidence (#404's rule),
 *     never by the absence of a line.
 */

import { readMarker } from "./reply-markers.ts";
import { trace } from "./trace.ts";
import type { DriverExecFn } from "./work-driver-context.ts";
import { detectMainline } from "./work-driver-git.ts";
import { GROUNDING_BASIS } from "./work-driver-intent-park-evidence.ts";
import { type NormalisedSpec, specIsActionable } from "./work-driver-intent.ts";

/** The commit a resolver cites for an `already-implemented` park, lowercased, or undefined. */
export function readImplementedAt(text: string): string | undefined {
  return readMarker(text, "IMPLEMENTED-AT", /([0-9a-f]{7,40})/);
}

/** Check an `already-implemented` park against the mainline; any other spec is returned as is. */
export async function groundAlreadyImplemented(
  spec: NormalisedSpec,
  replyText: string,
  repoRoot: string,
  execFn: DriverExecFn,
): Promise<NormalisedSpec> {
  if (spec.verdict !== "park" || spec.parkReason !== "already-implemented") return spec;
  const sha = readImplementedAt(replyText);
  if (sha === undefined) {
    trace(
      "work-driver: intent — already-implemented park cites no IMPLEMENTED-AT commit; not checked against mainline",
    );
    return spec;
  }
  const mainline = await detectMainline(repoRoot, execFn);
  if (!mainline.ok) {
    trace(`work-driver: intent — already-implemented not checked: ${mainline.reason}`);
    return spec;
  }
  const ref = `origin/${mainline.branch}`;
  const git = (args: string[]) =>
    execFn("git", { cwd: repoRoot, maxBuffer: 64 * 1024, argv: args });
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    trace(`work-driver: intent — already-implemented not checked: ${ref} does not resolve`);
    return spec;
  }
  try {
    await git(["merge-base", "--is-ancestor", sha, ref]);
    return spec;
  } catch {
    // Not an ancestor, or not a commit in this clone — either way not on the mainline.
  }
  trace(`work-driver: intent — already-implemented refuted: ${sha} is not on ${ref}`);
  const refutation = {
    text: `The explore step parked as already-implemented citing commit ${sha}, which is not on ${ref}. The driver did not accept the park.`,
    basis: GROUNDING_BASIS,
  };
  const { parkReason: _r, parkReasonSource: _rs, verdictSource: _vs, ...rest } = spec;
  const assumptions = [...spec.assumptions, refutation];
  if (specIsActionable(spec)) {
    return { ...rest, verdict: "proceed-with-assumptions", assumptions };
  }
  return {
    ...rest,
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "default",
    verdictSource: "parsed",
    assumptions,
  };
}
