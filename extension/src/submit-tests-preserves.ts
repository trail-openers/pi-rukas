/**
 * submit-tests-preserves — the ONE reader of a submitted row's `preserves` declaration.
 *
 * The child says which criterion it intends to KEEP working rather than break; the field arrives on the same
 * untrusted surface as `note` (an extractor reads what a model typed), so it is read the way the other
 * untrusted fields are: a non-boolean value is not coerced to truthy and not trusted, it is a malformed call,
 * counted with the existing skipped-call accounting and the whole row goes.
 *
 * A row the extractor kept is one whose schema Pi already accepted, so a present-but-wrong `preserves` at
 * this boundary is a call the model faked rather than one the tool accepted — the same rule the extractor's
 * own jsdoc states for `testFiles` and `note`.
 */
import { leanSpecifyPreservesEnabled } from "./lean-specify-preserves-switch.ts";

/** The key a `submit_tests` call carries its declaration under. */
export const PRESERVES_FIELD = "preserves";

/** Is this value a boolean? The declaration is a boolean or a malformed call; there is no truthy arm. */
export function isPreservesValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Read the declaration off one raw `submit_tests` call's arguments.
 *
 * `undefined` means the row declared nothing (or the switch is off, which makes the field unread as surely as
 * absent bytes are). `true`/`false` is the declaration; a `problem` is a value of the wrong type, which the
 * caller counts as a skipped call rather than keeping the row.
 */
export function readPreservesArgument(args: Record<string, unknown>): {
  preserves?: boolean;
  problem?: string;
} {
  const value = args[PRESERVES_FIELD];
  if (value === undefined) return {};
  if (!isPreservesValue(value))
    return {
      problem: `${PRESERVES_FIELD} must be a boolean (got ${typeof value})`,
    };
  // Switch off: the field is not part of the schema the child was offered, so a call carrying it is read as
  // the call without it — the off arm is the pre-field extractor byte for byte.
  if (!leanSpecifyPreservesEnabled()) return {};
  return { preserves: value };
}

/** The schema text for the declaration, so the reporter's field and this reader never drift apart. */
export const PRESERVES_SCHEMA_DESCRIPTION =
  "True when this criterion states behaviour that must KEEP working, so its test passes on the base by design. The file is then frozen and must pass at head. Omit or false for an ordinary red test.";
