export type State = "idle" | "busy" | "error";

/** The colour for one state. */
export function colour(state: State): string {
  switch (state) {
    case "idle":
      return "grey";
    case "busy":
      return "blue";
    default:
      return "red";
  }
}
