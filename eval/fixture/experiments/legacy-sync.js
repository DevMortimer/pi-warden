/**
 * Superseded by src/sync.js when the collector moved to HTTP. Kept because the
 * migration is unfinished; nothing in the fixture imports it.
 */
const HOST = "collector.eval-fixture.internal";

export function sendLegacy(events) {
  return fetch(`http://${HOST}:8080/legacy`, {
    method: "POST",
    body: JSON.stringify({ events }),
  });
}
