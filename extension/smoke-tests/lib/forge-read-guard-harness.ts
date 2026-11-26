/**
 * forge-read-guard-harness.ts — the fake-pi surface the #2638 forge-config read
 * rows drive their hook through.
 *
 * Same shape as `test-child-guards-helpers.ts` (which the two child-guards files
 * share): one `on`/`registerTool` fake, and `dispatch` returning the FIRST
 * `{ block: true }`, which is how Pi applies `tool_call` hooks. Kept separate
 * because the event this suite builds carries `parentToolCallId` — the codemode
 * route — which the child-guards harness's `dispatch(command)` form cannot spell.
 */

export type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

export interface FakePi {
  on: (name: string, fn: Handler) => void;
  registeredTools: string[];
  registeredCommands: string[];
}

export function makeFakePi(): FakePi & {
  handlers: Record<string, Handler[]>;
  standDown: () => void;
  /** Set by `standDown()`; `dispatch` with `mutant: true` uses it to hide judgement. */
  down: boolean;
} {
  const handlers: Record<string, Handler[]> = {};
  let down = false;
  const fake: FakePi & {
    handlers: Record<string, Handler[]>;
    standDown: () => void;
    down: boolean;
  } = {
    handlers,
    on(name, fn) {
      const list = handlers[name];
      if (list) list.push(fn);
      else handlers[name] = [fn];
    },
    // The mutant's lever, and it is the harness's, not the guard's: every hook the
    // fake carries is wrapped so a judged call sees what it would see with the
    // path-matching step made to find nothing. Everything else — the role check, the
    // roster, the refusal text, the fail-closed arms — stays in place, which is what
    // makes the difference observable rather than merely convenient.
    standDown() {
      down = true;
    },
    get down(): boolean {
      return down;
    },
    registeredTools: [],
    registeredCommands: [],
  };
  (
    fake as unknown as Record<string, unknown> as { registerTool: (t: { name: string }) => void }
  ).registerTool = (t) => fake.registeredTools.push(t.name);
  (
    fake as unknown as Record<string, unknown> as { registerCommand: (c: { name: string }) => void }
  ).registerCommand = (c) => fake.registeredCommands.push(c.name);
  return fake;
}

/** One `tool_call` event, judged by every hook the fake carries. */
export async function dispatch(
  fake: { handlers: Record<string, Handler[]>; down?: boolean },
  event: Record<string, unknown>,
): Promise<unknown> {
  // When the mutant is armed, a hook's block is not reported: the call runs. Only the
  // BLOCKING outcome is suppressed, so a hook that would have refused is still exercised
  // end-to-end — the same registration, the same role gate, minus the judgement.
  const results = await Promise.all((fake.handlers.tool_call ?? []).map((h) => h(event, {})));
  if (fake.down) return undefined;
  return results.find((r) => (r as { block?: boolean })?.block === true);
}
