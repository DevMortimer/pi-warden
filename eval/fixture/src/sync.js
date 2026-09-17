/**
 * Pushes events to a collector endpoint. Used by the sync tests task.
 * Deliberately minimal: the task is to test it, not to change it.
 */
export async function pushEvents(url, events) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
  return res.json();
}
