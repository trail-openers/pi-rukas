/**
 * lean/spec-blocks — the two prompt sections rendered straight from a `PiSpec`.
 *
 * One definition shared by `build-prompt.ts`, `specify-prompt.ts` and
 * `challenge-prompt.ts`: the rendering is the text those prompts are pinned on,
 * so a second copy could drift into the children reading different criteria.
 */
import type { PiSpec } from "./spec.ts";

/** The spec's criteria as prompt bullets, one per criterion. */
export function criteriaBlock(spec: PiSpec): string {
  return spec.criteria
    .map((c) => {
      const command = c.command === undefined ? "" : ` (command: ${c.command})`;
      return `- **${c.id}** [${c.verify}] ${c.text}${command}`;
    })
    .join("\n");
}

/** The spec's scope as prompt bullets, or `""` when it declares none. */
export function scopeBlock(spec: PiSpec): string {
  const lines: string[] = [];
  if (spec.scope?.paths && spec.scope.paths.length > 0)
    lines.push(`- In scope: ${spec.scope.paths.join(", ")}`);
  if (spec.scope?.out && spec.scope.out.length > 0)
    lines.push(`- Out of scope: ${spec.scope.out.join(", ")}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}
