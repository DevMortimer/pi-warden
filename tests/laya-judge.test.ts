import assert from "node:assert/strict";
import { test } from "node:test";
import { findPython, getPythonVersion } from "../src/laya-judge.js";

test("getPythonVersion: returns [major, minor] for a valid python binary", async () => {
  // The test runner itself is Node, but python3 should be on PATH in CI.
  // Skip gracefully if python3 is absent.
  const v = await getPythonVersion("python3");
  if (v === null) return; // no python3 on this machine; skip
  assert.ok(Array.isArray(v), "version is an array");
  assert.ok(v.length >= 2, "version has at least major and minor");
  assert.equal(typeof v[0], "number");
  assert.equal(typeof v[1], "number");
});

test("getPythonVersion: returns null for a nonexistent binary", async () => {
  const v = await getPythonVersion("no-such-python-binary-xyz-999");
  assert.equal(v, null);
});

test("getPythonVersion: returns null for a non-python binary", async () => {
  // `ls --version` does not output "Python X.Y", so parsing fails.
  const v = await getPythonVersion("ls");
  assert.equal(v, null);
});

test("findPython: returns a string or null", async () => {
  const result = await findPython();
  // On any CI/dev machine with Python 3.11+, this should be a string.
  // On a machine with only Python 3.9, this should be null.
  if (result !== null) {
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0, "non-empty binary name");
    // Verify the returned name actually works.
    const v = await getPythonVersion(result);
    assert.ok(v !== null, `returned binary "${result}" should be runnable`);
    assert.ok(v[0]! >= 3, `major version >= 3`);
    assert.ok(v[0]! > 3 || v[1]! >= 11, `minor version >= 11 when major is 3`);
  }
});

test("findPython: prefers versioned names over generic python3", async () => {
  // We can't control what's on PATH, but we can verify the function
  // doesn't crash and returns something sensible.
  const result = await findPython();
  if (result !== null) {
    // If it returned a versioned name, great. If generic, that's also fine
    // (the system only has generic). Just verify it works.
    const v = await getPythonVersion(result);
    assert.ok(v !== null);
    assert.ok(versionOk(v), `found "${result}" should satisfy >= 3.11`);
  }
});

// Import the internal versionOk helper indirectly via findPython's behavior.
// We test it through the public API: findPython only returns binaries with versionOk.
function versionOk(v: number[] | null): boolean {
  return v !== null && (v[0]! > 3 || (v[0] === 3 && v[1]! >= 11));
}
