/**
 * plan-title-ask — the one follow-up a /plan issue title gets.
 *
 * The caller of `start_plan_driver` writes the title. When a given `title`
 * would not fit {@link TITLE_BUDGET} (prefix included), the launch is refused
 * ONCE per descriptor with a request for a shorter one; the next launch for
 * that descriptor files whatever title it carries, whole. A call with no
 * `title` is never refused: its title is the descriptor's first sentence, whole.
 * A refused launch costs one tool call and dispatches nothing.
 */

import { classifyPlanType, planTitle } from "./plan-types.ts";
import type { PlanType } from "./plan-types.ts";
import { TITLE_BUDGET, fitsTitle } from "./work-title.ts";

/** Descriptors already asked for a shorter title, oldest first, bounded. */
const asked: string[] = [];
const ASKED_LIMIT = 64;

/** `undefined` when the launch may go ahead, else the refusal text to return. */
export function planTitleAsk(
  descriptor: string,
  type: PlanType | undefined,
  title: string | undefined,
): string | undefined {
  if (title === undefined) return undefined;
  const filed = planTitle(descriptor, classifyPlanType(descriptor, type), title);
  const shown = `${filed.length} characters (${JSON.stringify(filed)})`;
  if (fitsTitle(filed)) return undefined;
  const key = descriptor.trim();
  if (asked.includes(key)) return undefined;
  asked.push(key);
  if (asked.length > ASKED_LIMIT) asked.shift();
  return `start_plan_driver: the issue title would be ${shown}. Re-call with the same descriptor and a \`title\`: one complete phrase saying what the change does, at most ${TITLE_BUDGET} characters including the type prefix. The driver never cuts a title; this is the only time it asks.`;
}
