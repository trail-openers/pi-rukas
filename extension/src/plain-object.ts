/**
 * plain-object — the ONE "can this value BE a record anybody built" test.
 *
 * Three channels used to carry their own copy of this predicate: the plan
 * companion's import graph (`plan-workstream-schema.ts`'s `isEchoObject`), the
 * spawn collapse path (`spawn-collapse-events.ts`'s `isObjectLike`) and the
 * issue-filing provenance validators (`plan-provenance.ts`'s `isPlainObject`).
 * Copies of a trust predicate are how one channel starts accepting a shape the
 * other refuses — and this one decides whether a value the driver JUDGES (a
 * companion's echo of the arguments it recorded, #1756) is even allowed to be
 * judged.
 *
 * It lives here rather than in `plan-provenance.ts` because the companion is
 * loaded into the plan child with `--extension` and its graph must stay this
 * file plus TypeBox and `plan-path-shape.ts`; pulling the issue-filing module
 * into that child for a five-line type guard is the cost the leaf removes.
 */

/**
 * A value that can BE a record: an object (not an array) whose prototype is
 * `Object.prototype` or `null`. The null-prototype case is what `JSON.parse` of
 * a payload carrying `"__proto__"` produces, and it is a value a transport can
 * legitimately hand over; an `Object.create({ id: "x" })` is not — the reader
 * must only ever judge values JSON produced or the companion built, never one
 * whose properties arrive through an inherited chain.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
