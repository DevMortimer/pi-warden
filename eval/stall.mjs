/**
 * The stall rule of the A/B batch: a run whose session log shows no new assistant
 * message and no new tool result for the stall limit (15 minutes in the registration)
 * is killed as stalled. A stalled run is an infrastructure failure, retried and
 * excluded like an API error (eval/batch.mjs `infraReason`). The slow, flat-rate
 * provider can get stuck without ever returning an error, and a stuck run holds a
 * slot of the batch until the timeout, so the stall rule frees it much sooner.
 *
 * Progress is counted from the session log alone, never from a wall-clock guess: the
 * watch sees the count of assistant messages and tool results, and the time it last
 * grew. Pure, shares no code with the guard, like the other scorers.
 */

/** The messages that show a run is alive: assistant messages and tool results. */
export const progressCount = (events) =>
  events.filter((e) => e.message?.role === "assistant" || e.message?.role === "toolResult").length;

/**
 * A watch started at `now` with `count` messages already in the log (a multi-turn run
 * continues its session, so a turn starts from the count the earlier turns left).
 * `check(count, now)` returns true once the count has not grown for `stallMs`.
 */
export function createStallWatch({ stallMs, now, count = 0 }) {
  let seen = count;
  let since = now;
  return {
    check(current, at) {
      if (current > seen) {
        seen = current;
        since = at;
        return false;
      }
      return at - since >= stallMs;
    },
  };
}
