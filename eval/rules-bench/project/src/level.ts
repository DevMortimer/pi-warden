export type Level = "info" | "warn" | "error";

/** The single-letter prefix for one level. */
export function prefix(level: Level): string {
  switch (level) {
    case "info":
      return "i";
    case "warn":
      return "!";
    case "error":
      return "x";
  }
  return "?";
}
