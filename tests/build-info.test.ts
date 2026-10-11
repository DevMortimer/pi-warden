import assert from "node:assert/strict";
import { test } from "node:test";
import { readWardenBuild, satisfiesCaret } from "../src/build-info.js";

// The stale-build and pi-typesafe-range warnings at session start turn on these two helpers. `readWardenBuild` must
// name the running package even when the shipped entry is missing; `satisfiesCaret` must not page the user about a
// version it cannot parse, so an unreadable range or version passes.
test("satisfiesCaret reads the caret range pi-warden declares", () => {
  assert.equal(satisfiesCaret("0.9.1", "^0.9.1"), true, "the declared version satisfies its own range");
  assert.equal(satisfiesCaret("0.9.2", "^0.9.1"), true, "a patch above the range satisfies it");
  assert.equal(satisfiesCaret("0.9.0", "^0.9.1"), false, "a patch below the range does not");
  assert.equal(satisfiesCaret("0.10.0", "^0.9.1"), false, "a caret on 0.x holds the minor line (^0.9.1 := >=0.9.1 <0.10.0)");
  assert.equal(satisfiesCaret("1.2.3", "^1.2.0"), true, "above 0 a caret holds the major");
  assert.equal(satisfiesCaret("2.0.0", "^1.2.0"), false, "a different major does not");
  assert.equal(satisfiesCaret("not-a-version", "^0.9.1"), true, "an unreadable version never warns");
  assert.equal(satisfiesCaret("0.9.1", ">=0.9.0"), true, "an unreadable range never warns");
});

test("readWardenBuild names the running package and the loaded pi-typesafe", () => {
  const build = readWardenBuild();
  assert.match(build.version, /^\d+\.\d+\.\d+/, "the package version is a semantic version");
  assert.match(build.typesafeRange ?? "", /^\^\d+\.\d+\.\d+$/, "the pi-typesafe dependency is a caret range");
  assert.match(build.typesafeVersion ?? "", /^\d+\.\d+\.\d+/, "the loaded pi-typesafe version is resolved");
  assert.equal(typeof build.stale, "boolean", "staleness is always decided");
  assert.ok(build.commit === undefined || /^[0-9a-f]{7,}$/.test(build.commit), "a commit is a short or full hash when the package is a checkout");
});
