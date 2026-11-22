/**
 * lib/forge-read-child-pair — the child env the #2284 forge-off cases hand a
 * child, kept out of `lib/forge-read-auth-fixture.ts` on purpose.
 *
 * The fixture's `pair` is `childEnv(...)`, and `childEnv` widens its own values
 * to `string | undefined` because a case deletes an entry by passing `undefined`.
 * `pair` narrows that back to `Record<string, string>` — a claim about a map
 * `childEnv` can produce with `undefined` in it. That is the fixture's business
 * and the two auth suites never exercised the widening; making the forge-off
 * cases the first to do so would put a type defect they do not share on this
 * ticket's error list. So these cases build the pair themselves, and the existing
 * fixture is left exactly as its own suites typed it.
 */

// The two env NAMES, spelled as the literals the activation module declares them
// to be. Importing that module here would pull its `@earendil-works/pi-coding-agent`
// and `typebox` value imports into this project's typecheck, which pins
// `"types": ["node"]` and has never seen those packages resolved; the two existing
// auth suites reach the fixture, not this module, and stay untouched. The
// activation module is the source these literals are kept in step with.
const FORGE_READ_SOCKET_ENV = "PI_ENSEMBLE_FORGE_READ_SOCKET";
const FORGE_READ_SECRET_ENV = "PI_ENSEMBLE_FORGE_READ_SECRET";

/**
 * A helper child's env: the role the spawn layer sets, plus the broker pair this
 * parent bound. The role is written explicitly rather than left ambient —
 * registration is gated on it, and an ambient one is whatever the runner's parent
 * happened to set, which is how a refusal a case meant to observe is silently
 * replaced by "the tool was never there".
 */
export const childPair = (socket: string, secret: string): Record<string, string> => ({
  PI_ENSEMBLE_ROLE: "developer",
  [FORGE_READ_SOCKET_ENV]: socket,
  [FORGE_READ_SECRET_ENV]: secret,
});
