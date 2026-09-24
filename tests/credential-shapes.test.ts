import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecrets, looksLikeSecretValue } from "../src/redact.js";

test("placeholders, plain numbers, and code identifiers are not credentials; a real-shaped key still is", () => {
  // Three outputs from real sessions that each earned a false credential notice.
  const samples: Array<[string, string]> = [
    ["sed output of a redacted env file", "DATABASE_URL=<redacted>\nTYPESAFE_API_KEY=<redacted>\nGITHUB_TOKEN=<redacted>"],
    ["JSON token counts", '{"model": "jev-latest", "promptTokens": 14350, "cacheReadTokens": 19415506, "cacheWriteTokens": 797330}'],
    ["grep of source lines that handle secrets", [
      "src/extension.ts:1359:    const secretValues = output.secretIds ?? (output.secret && output.secretId !== undefined ? [output.secretId] : []);",
      "src/extension.ts:1361:    const unseenSecrets = secretValues.filter((id) => !secretsSeen.has(id));",
      "src/load.ts:151:  const secrets = findSecrets(body);",
      "src/redact.ts:141:export function secretIds(secrets: readonly string[]): string[] {",
      "tests/violation.test.ts:281:  const secret: Violation = {",
      "src/output.ts:242:    secret: secretBlocks.length > 0,",
    ].join("\n")],
  ];
  for (const [name, text] of samples) assert.deepEqual(findSecrets(text), [], name);
  // Every placeholder form: an angle bracket, a run of stars, an ellipsis, REDACTED in any case, a run of x.
  for (const form of ["<redacted>", "<...>", "<sk-live-token>", "***", "************", "…", "...", "REDACTED", "ReDaCtEd", "xxxx", "XXXXXXXX"]) {
    assert.deepEqual(findSecrets(`API_KEY=${form}`), [], form);
  }
  // Plain numbers, with `_` or `,` separators allowed.
  for (const text of ["API_KEY=19415506", "API_KEY=797330_123", "Authorization: Bearer 19,415,506"]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
  // A key name with no value, or with an identifier or expression in code as its value.
  for (const text of [
    "secretValues secretIds unseenSecrets findSecrets(text)",
    "const unseenSecrets = secretValues.filter((id) => !secretsSeen.has(id));",
    "const secrets = findSecrets(body);",
    "verdict.secretIds = secretIds(real);",
    "const secretId = output.secretIds;",
    "const secret: Violation = { id: \"x\" };",
  ]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
  // A real-shaped 40-character mixed key after API_KEY= is still found, exactly once.
  const key = ["k7Rm2Qx9Lp4Ns8Vt1Wd6", "Yc3Zb5Hf7Jg0Pk2Mn5Qz"].join(""); // split so repository secret scanners do not read a fixture as a live key
  assert.equal(key.length, 40);
  assert.deepEqual(findSecrets(`API_KEY=${key}`), [key]);
  assert.ok(looksLikeSecretValue(key));
  // A bracket inside a password is a password, not code: the value is still found.
  for (const text of ["DB_PASSWORD=Tr0ub(4dor)&3xK9", "API_KEY=abc[123]DEFghi789", "password: s3cr3t{Qz}Lk8m"]) {
    assert.ok(findSecrets(text).length >= 1, text);
  }
});
