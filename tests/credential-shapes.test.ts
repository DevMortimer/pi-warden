import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecrets, looksLikeSecretValue, maskSecrets, partitionSecrets, redact } from "../src/redact.js";

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

// Real-shaped pieces, each split so repository secret scanners do not read a fixture as a live key.
const accessKey = ["AKIA3M7QZ2", "PRT9LVXW8Y"].join("");
const signature = ["9c4e1a7b2f8d3e6a0b5c9d2e7f1a4b8c", "3d6e0f2a5b9c1d4e7f8a2b6c0d3e5f91"].join("");
const opaque = ["Qx7Lm2Rt9Vk4", "Np8Wd3Hz6Jc1"].join("");

/** Found, but announced and masked as nothing: every value is a stand-in, and the text comes back unchanged. */
function assertSignedUrl(name: string, text: string): void {
  const found = findSecrets(text);
  assert.ok(found.length > 0, `${name}: the URL carries credential-shaped values`);
  assert.deepEqual(partitionSecrets(found, text).real, [], `${name}: no notice`);
  assert.deepEqual(maskSecrets(text), { text, masked: 0 }, `${name}: no masking`);
}

test("an S3 presigned URL is not a credential", () => {
  assertSignedUrl("s3", `"url": "https://uploads.s3.us-east-1.amazonaws.com/team/a1/shot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${accessKey}%2F20260924%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260924T101010Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}"`);
});

test("a GCS signed URL is not a credential", () => {
  assertSignedUrl("gcs", `https://storage.googleapis.com/assets-7f3/doc.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=uploader%40proj-4821.iam.gserviceaccount.com%2F20260924%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260924T101010Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=${signature}`);
});

test("a storage token= URL with an expiry is not a credential", () => {
  assertSignedUrl("token", `![image](https://objects.storagehost.net/v1/files/report.pdf?se=2026-09-24T12%3A00%3A00Z&token=${opaque})`);
});

test("a bare token= outside a signed URL still counts, and so does a signed-URL value that also appears on its own", () => {
  const bare = `token=${opaque}`;
  assert.deepEqual(partitionSecrets(findSecrets(bare), bare).real, [opaque]);
  assert.deepEqual(maskSecrets(bare), { text: "token=[redacted]", masked: 1 });
  // No expiry parameter: not a signed URL.
  const unsigned = `https://objects.storagehost.net/v1/files/report.pdf?token=${opaque}`;
  assert.deepEqual(partitionSecrets(findSecrets(unsigned), unsigned).real, [opaque]);
  const reused = `https://objects.storagehost.net/f.pdf?Expires=1790000000&token=${opaque}\nAPI_TOKEN=${opaque}`;
  assert.deepEqual(partitionSecrets(findSecrets(reused), reused).real, [opaque]);
  // Redaction before anything leaves the machine is unchanged.
  assert.ok(!redact(`https://objects.storagehost.net/f.pdf?se=2026-09-24&token=${opaque}`).includes(opaque));
});

test("a credential value containing & is redacted whole; & as a separator still ends the value", () => {
  const password = ["Tr0ub4dor", "&3xK9"].join("");
  const line = `DB_PASSWORD=${password}`;
  assert.equal(redact(line), "DB_PASSWORD=[redacted]");
  assert.deepEqual(findSecrets(line), [password]);
  assert.deepEqual(maskSecrets(line), { text: "DB_PASSWORD=[redacted]", masked: 1 });
  // A URL query: only the token is redacted, the next parameter stays.
  const token = ["abc123", "def456"].join("");
  const query = `https://x.test/cb?token=${token}&next=/home`;
  assert.equal(redact(query), "https://x.test/cb?token=[redacted]&next=/home");
  assert.deepEqual(findSecrets(query), [token]);
  assert.equal(maskSecrets(query).text, "https://x.test/cb?token=[redacted]&next=/home");
  // A shell `&&` after the value is kept.
  const key = ["k7Rm2Qx9", "Lp4Ns8Vt"].join("");
  const chained = `API_KEY=${key} && npm test`;
  assert.equal(redact(chained), "API_KEY=[redacted] && npm test");
  assert.deepEqual(findSecrets(chained), [key]);
  assert.equal(maskSecrets(chained).text, "API_KEY=[redacted] && npm test");
  const tight = `API_KEY=${key}&&npm test`;
  assert.equal(redact(tight), "API_KEY=[redacted]&&npm test");
  assert.equal(maskSecrets(tight).text, "API_KEY=[redacted]&&npm test");
});

test("an S3 presigned URL made with temporary credentials is not a credential", () => {
  const sessionToken = ["IQoJb3JpZ2luX2VjEJr%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDx7Kp2Rm9", "Lq4Tz8Wn3Vb6Hd1Jc5Ys0GaKu2Re7Nt4Mx9Lp3Vz8Hq1Wd6Bj5Cf0Ys2Tg7Nk%3D"].join("");
  assertSignedUrl("s3 temporary", `https://uploads.s3.us-east-1.amazonaws.com/team/a1/shot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${["ASIA3M7QZ2", "PRT9LVXW8Y"].join("")}%2F20260924%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260924T101010Z&X-Amz-Expires=3600&X-Amz-Security-Token=${sessionToken}&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`);
});
