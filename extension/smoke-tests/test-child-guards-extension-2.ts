#!/usr/bin/env bun
/**
 * #926 hardening round — failClosedPi as a PROTOTYPE-INHERITING object.
 *
 * Section 8 of test-child-guards-extension.ts was moved here verbatim (the
 * file hit the 500-line hard limit; tests are not reformatted/compressed).
 *
 *   8.  A CLASS-based pi whose `on` lives on the PROTOTYPE (non-enumerable)
 *       must still route tool_call registrations through the wrapper — the
 *       old Object.keys(pi) copy missed prototype members entirely (they
 *       are not own enumerable properties) and produced a wrapper with no
 *       `on`. A throwing handler must still become a fail-closed block.
 *   8b. A pi object WITHOUT `on` gets the named refusal error (a guard
 *       wrapper that could not register hooks must never load as if it did).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failClosedPi } from "../src/child-guards.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

// 8. failClosedPi as a PROTOTYPE-INHERITING object (#926 hardening round):
// a CLASS-based pi whose `on` lives on the PROTOTYPE (non-enumerable) must still route
// registrations through the wrapper (the old Object.keys(pi) copy missed them); a throwing
// handler must still become a fail-closed block; a pi WITHOUT `on` gets the named refusal.
{
  class PrototypePi {
    handlers: Record<string, Handler[]> = {};
    on(name: string, fn: Handler) {
      (this.handlers[name] ??= []).push(fn);
    }
  }
  const protoPi = new PrototypePi();
  const wrappedProto = failClosedPi(protoPi as unknown as ExtensionAPI);
  const underlying: Handler = () => {
    throw new Error("boom-prototype");
  };
  wrappedProto.on("tool_call", underlying);
  assert(
    (protoPi.handlers["tool_call"] ?? []).length === 1,
    "prototype-pi: the wrapped registration reached the real pi's prototype `on`",
  );
  const p = (await (protoPi.handlers["tool_call"]?.[0] as Handler)(
    { toolName: "bash", input: { command: "true" } },
    {},
  )) as { block?: boolean; reason?: string } | undefined;
  assert(
    p?.block === true &&
      /fail-closed/.test(p?.reason ?? "") &&
      /boom-prototype/.test(p?.reason ?? ""),
    "prototype-pi: a throwing handler becomes a fail-closed block naming the error",
  );
  // The wrapper must NOT shadow pi's other surface: an inherited property is
  // still visible through the wrapper (the Object.create(pi) inheritance).
  assert(
    Object.getPrototypeOf(wrappedProto as object) === protoPi,
    "prototype-pi: the wrapper inherits from the real pi (prototype chain intact)",
  );
}

// 8b. A pi object without `on` → the named refusal error (a guard wrapper
// that could not register hooks must never load as if it did).
{
  const noOnPi = {} as unknown as ExtensionAPI;
  let threw = "";
  try {
    failClosedPi(noOnPi);
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(
    /ExtensionAPI has no `on`/.test(threw) && /refusing to load without guards/.test(threw),
    `no-on pi: the named error is thrown (got: ${threw || "nothing thrown"})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
