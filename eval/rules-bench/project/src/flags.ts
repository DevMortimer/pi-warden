export interface Flags {
  mode: string;
}

/** Whether the feature runs in this mode. */
export function enabled(config: Flags): boolean {
  const isOff = config.mode === "off";
  return !isOff;
}
