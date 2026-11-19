/**
 * lib/bash-timeout-harness — the fake-pi harness the two per-call bash-bound
 * gates drive their cases through: the #2140 reviewer arm
 * (`test-review-bash-timeout.ts`) and the #2377 developer arm
 * (`test-developer-bash-timeout.ts`).
 *
 * The harness is shared because the two gates ask the same question of the same
 * shipped hooks — what did `event.input.timeout` become after the companion's
 * `tool_call` handlers ran — and a second copy of the driver is where the two
 * would drift: a harness that stopped loading one guard would make one file
 * green while the shipped hook stayed unbounded. Both files load the real
 * companion (`child-guards.ts`), so a mutation of the hook or of its
 * registration fails at least one of them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../../src/child-guards.ts";
import { withEnv } from "./env-scope.ts";
import { makeFakePi } from "../test-child-guards-helpers.ts";

/** The reviewer arm's default, in the SECONDS Pi's bash schema takes (600000 ms). */
export const REVIEWER_BOUND = 600;
/** The developer arm's default, in the same unit (900000 ms). */
export const DEVELOPER_BOUND = 900;

/**
 * Drive one tool call through the hooks the companion actually installs, with
 * the child environment pinned. Returns the (possibly mutated) input.
 *
 * `PI_ENSEMBLE_ROLE` is DELETED before the per-case env is applied rather than
 * defaulted to a role: an ambient role in whoever's shell would otherwise make
 * an "untouched" case mean "untouched for that ambient role too" — and the
 * untouched cases are the whole point of the role-scoping section.
 */
export async function call(
  env: Record<string, string | undefined>,
  toolName: string,
  input: Record<string, unknown> | null,
  parentToolCallId?: string,
): Promise<Record<string, unknown> | null> {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const event: Record<string, unknown> = { toolName, input };
  if (parentToolCallId !== undefined) event.parentToolCallId = parentToolCallId;
  await withEnv({ PI_ENSEMBLE_ROLE: undefined, ...env }, async () => {
    for (const h of fake.handlers.tool_call ?? []) await h(event, {});
  });
  return event.input as Record<string, unknown> | null;
}

/** A reviewer's bash call (the role both reviewer roles share the hook with). */
export const reviewer = (
  env: Record<string, string | undefined>,
  input: Record<string, unknown>,
  parentToolCallId?: string,
) =>
  call({ PI_ENSEMBLE_ROLE: "code-review-specialist", ...env }, "bash", input, parentToolCallId);

/** A developer child's bash call (the #2377 arm). */
export const developer = (
  env: Record<string, string | undefined>,
  input: Record<string, unknown>,
  parentToolCallId?: string,
) => call({ PI_ENSEMBLE_ROLE: "developer", ...env }, "bash", input, parentToolCallId);

/**
 * Drive one bash call through the companion's hooks with the role pinned and an
 * input object the caller froze. A frozen input is the shape that would turn a
 * thrown write into a `{ block: true }` refusal through the companion's
 * fail-closed wrapper, so both arms assert it neither throws nor blocks.
 */
export async function throughFrozenInput(
  role: string,
  input: Record<string, unknown>,
): Promise<{ threw: boolean; blocked: boolean }> {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  let result: unknown;
  let threw = false;
  await withEnv({ PI_ENSEMBLE_ROLE: role }, async () => {
    for (const h of fake.handlers.tool_call ?? []) {
      try {
        result = await h({ toolName: "bash", input }, {});
      } catch {
        threw = true;
      }
    }
  });
  return { threw, blocked: (result as { block?: boolean } | undefined)?.block === true };
}
