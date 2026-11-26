/**
 * lean/request-stall-switch — the ONE reader of the lever that ends a lean model
 * request whose stream has gone quiet; the window itself is `lean/request-stall.ts`.
 *
 * Default ON. Only the literal `"0"` turns it off, read at CALL time: `"0"` is what an
 * operator reaches for, and every other value — `""`, `"false"`, `"NO"`, a mangled
 * `" 0 "` — leaves the shipped behaviour in place, because a switch that a shell
 * accident could switch off is a lost cell waiting to happen. With it off, the step's
 * per-child ceilings (`minutes`/`turns`/`tokens`) are the only levers again and a hung
 * request is bounded only by the harness's outer wall — the pre-change behaviour.
 */
export const leanRequestStallEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_REQUEST_STALL !== "0";
