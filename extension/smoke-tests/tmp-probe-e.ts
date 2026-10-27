import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { foldMerged, foldSelfFenceNotes } from "./lib/fold-two-helpers.ts";
import { foldSelfFenceDrops } from "../src/workstream-fold-self-fence.ts";
const VALID = { id:"x", scope:"s", paths:["p"], outOfScope:[] } as any;
const ESC = String.fromCharCode(27);
// 1. boundary drops a path-shaped self-fence; does the FOLD see it? (simulated plan: boundary -> fold)
const a = workstreamFromArgs({...VALID, id:"a", paths:["tests/x.py","docs/y.md"], outOfScope:[]});
const b = workstreamFromArgs({...VALID, id:"b", paths:["docs/y.md"], outOfScope:["docs/"]});
console.log("stored b:", JSON.stringify(b.outOfScope));
console.log("merged:", JSON.stringify(foldMerged(a,b).outOfScope), "notes", JSON.stringify(foldSelfFenceNotes(a,b)));
// 2. control byte that breaks a token
const raw = `Every file under docs${ESC}/y.md is frozen`;
console.log("fold drop w/ ESC:", JSON.stringify(foldSelfFenceDrops("a", ["docs/y.md"], [raw])));
// 3. trailing formfeed in token
const ff = `Every file under docs/y.md\f is frozen`;
console.log("fold drop w/ FF:", JSON.stringify(foldSelfFenceDrops("a", ["docs/y.md"], [ff])));
