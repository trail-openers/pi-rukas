import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { selfFenceDropsBetween, withBoundaryDrops } from "../src/plan-fence-self-entry.ts";
import { foldMerged } from "./lib/fold-two-helpers.ts";
const VALID = { id:"x", scope:"s", paths:["p"], outOfScope:[] } as any;
// 1. the ESC-broken array entry: is it stored raw?
const raw = `["src/${String.fromCharCode(27)}/a.ts"]`;
const ws = workstreamFromArgs({...VALID, id:"a", paths:[`src/${String.fromCharCode(27)}/a.ts`], outOfScope:[raw]});
console.log("1 stored:", JSON.stringify(ws.outOfScope), "rawHadESC:", ws.outOfScope[0]?.includes(String.fromCharCode(27)));
// 2. array member + plain duplicate: is a collapse recorded anywhere?
const dup = workstreamFromArgs({...VALID, id:"b", paths:["src/b.ts"], outOfScope:["docs/", '["docs/","tests/"]']});
console.log("2:", JSON.stringify(dup.outOfScope), "clippedField:", JSON.stringify(dup.outOfScopeClipped));
// 3. fold-before-unfence: the unfence's no-owner rollback can reinstate a self-fence
const stored = { a: { paths:["tests/x.py"], outOfScope:[] } };
const reported = { a: { id:"a", paths:["tests/x.py"], outOfScope:["tests/"] } };
const drops = selfFenceDropsBetween(stored, reported);
console.log("3 drops:", JSON.stringify(drops));
console.log("3 summary (unfence undefined):", JSON.stringify(withBoundaryDrops(undefined, drops)));
