import { finalDraftBody } from "./plan-gap-disclosure.ts";
import type { DuplicateRisk } from "./plan-investigate.ts";
import type { PlanDriverInput, PlanGap, PlanType } from "./plan-types.ts";
import type { IssueImage } from "./work-driver-issue-images.ts";

/**
 * The driver's one call into `finalDraftBody`, spelled out here so the driver
 * keeps its orchestration and this file owns the argument order (#1883: the
 * ticket TYPE and the filed TITLE are the last two inputs, and both are what the
 * `pi-spec v1` block is derived from — a call site that passes neither files the
 * pre-#1883 body, which is the safe direction).
 */
export function assembleFinalBody(args: {
  body: string;
  residual: PlanGap[];
  openPoints: PlanGap[];
  baseFallback: string | undefined;
  images: IssueImage[];
  provenance: PlanDriverInput["provenance"];
  duplicate: { risk: DuplicateRisk | undefined; sourceIssue: number | undefined };
  piSpec: { type: PlanType; title: string };
}): string {
  return finalDraftBody(
    args.body,
    args.residual,
    args.openPoints,
    args.baseFallback,
    args.images,
    args.provenance,
    args.duplicate,
    args.piSpec,
  );
}
