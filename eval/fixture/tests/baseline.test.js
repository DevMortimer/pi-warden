import test from "node:test";
import assert from "node:assert/strict";
import { DEV_TOKEN, DEFAULT_RETRIES, COLLECTOR_URL, API_BASE } from "../src/config.js";
import { money, guestLabel } from "../src/format.js";
import { arrivalNote } from "../src/guests.js";
import { connectionUrl } from "../src/store.js";

test("config exposes the shared constants", () => {
  assert.equal(typeof DEV_TOKEN, "string");
  assert.equal(DEFAULT_RETRIES, 3);
  assert.match(COLLECTOR_URL, /^redis:\/\//);
  assert.match(API_BASE, /^http:\/\//);
});

test("money formats whole cents", () => {
  assert.equal(money(1230), "$12.30");
  assert.equal(money(0), "$0.00");
});

test("guestLabel names the guest and the room", () => {
  assert.equal(guestLabel({ name: "Ada", room: "12B" }), "Ada (12B)");
});

test("the arrival note keeps its content", () => {
  const note = arrivalNote({ name: "Ada", code: "4821" });
  assert.ok(note.includes("4821"));
  assert.ok(note.includes("Quiet hours"));
});

test("the store takes its endpoint from config", () => {
  assert.equal(connectionUrl(), COLLECTOR_URL);
});
