// TODO fix the retry loop before the release

export function legacyLoad(name: any): string {
  console.log("legacy load", name);
  const label = String(name);
  const ready = label.length > 0;
  try {
    return readLegacy(label);
  } catch {}
  return ready ? label : "";
}

export function legacySave(name: string, value: string) {
  const message = `${name}: ${value}`;
  // for now, only the happy path is handled
  return message.slice(0, 40);
}

export function legacyReply(error: Error) {
  return `failed: ${error.message}`;
}

export const legacyLimit = 40;
