/**
 * plan-images — an issue's images, given to /plan the way /work gets them.
 *
 * The manifests are the ones `/work` reads (work-driver-issue-images.ts):
 * same directories, same refusals, same limits, same "untrusted" section.
 * Pi drops the images of an RPC `prompt` whose text is an extension command
 * (`AgentSession.prompt` runs the command and returns before it reads
 * `options.images`), so a launcher cannot attach them to `/plan …` itself;
 * the extension reads them in its own process instead.
 *
 * Which manifest: `/work` matches a manifest's `issue` to its own, and `/plan`
 * has no issue number. `PI_ENSEMBLE_PLAN_ISSUE` names it. Without the
 * variable, a single manifest (or several for one issue) is used; manifests
 * for two or more issues attach nothing, because guessing would give the plan
 * another issue's screenshots with nothing to say so.
 *
 * The images reach three places: the `/plan` alias message (commands.ts), every
 * child `start_plan_driver` dispatches (its investigation and its gap gate), and
 * the filed body, which keeps their links so a later `/work` on the filed issue
 * can fetch them again.
 */
import type { PlanDispatchFn } from "./plan-driver-seams.ts";
import { trace } from "./trace.ts";
import {
  type IssueImage,
  imageDirs,
  issueImagesEnabled,
  issueImagesSection,
  loadIssueImages,
  manifestIssue,
  withIssueImages,
} from "./work-driver-issue-images.ts";

/** The images a planning session is given. Empty when there is nothing to give; never throws. */
export async function loadPlanImages(env: NodeJS.ProcessEnv = process.env): Promise<IssueImage[]> {
  if (!issueImagesEnabled(env)) return [];
  const named = env.PI_ENSEMBLE_PLAN_ISSUE?.trim();
  if (named) {
    if (!/^[1-9][0-9]{0,9}$/.test(named)) {
      trace(
        `plan: PI_ENSEMBLE_PLAN_ISSUE="${named.slice(0, 20)}" is not an issue number — no images`,
      );
      return [];
    }
    return loadIssueImages([Number(named)], env);
  }
  const issues = new Set<number>();
  for (const dir of imageDirs(env)) {
    const issue = await manifestIssue(dir);
    if (issue !== undefined) issues.add(issue);
  }
  if (issues.size > 1) {
    trace(
      `plan: manifests for issues ${[...issues].join(", ")} and no PI_ENSEMBLE_PLAN_ISSUE — no images (set it to choose one)`,
    );
    return [];
  }
  const [only] = issues;
  return only === undefined ? [] : loadIssueImages([only], env);
}

/**
 * The filed body's section that keeps the images' links. "" when no image has
 * a link, so a body without images is byte-identical to today's.
 */
export function planImageLinksSection(images: IssueImage[]): string {
  const linked = images.filter((i) => i.link);
  if (linked.length === 0) return "";
  return [
    "",
    "",
    "## Images from the source issue",
    "",
    "The issue this was planned from links these images. The plan was made with them in view.",
    "",
    ...linked.map((i) => `- ![${i.file}](${i.link})`),
  ].join("\n");
}

/** A plan child's dispatch: the images ride on every spec, with the section that names them. */
export function withPlanImages(images: IssueImage[], dispatch: PlanDispatchFn): PlanDispatchFn {
  return withIssueImages(dispatch, images, issueImagesSection(images, "planChild"));
}
