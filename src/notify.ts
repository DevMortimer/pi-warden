import { execFile } from "node:child_process";

/**
 * Desktop notifications for the moments the user has to come back to the terminal: a held call the agent will ask
 * about, a confirm dialog waiting for an answer, a stopped runaway. The notifier is detected once per session with a
 * probe (never inside a tool_call handler); sending is fire-and-forget, and a failure is silent.
 */
export type NotifierName = "osascript" | "notify-send" | "dunstify" | "gdbus" | "kdialog" | "zenity" | "powershell" | "wsl-powershell";

export interface Notification {
  title: string;
  body: string;
}

export interface NotifierCommand {
  file: string;
  args: string[];
  /** Text travels in the environment where the shell needs no quoting (PowerShell). */
  env?: Record<string, string>;
}

interface Candidate {
  name: NotifierName;
  /** Probe: the command exists and answers. */
  probe: { file: string; args: readonly string[] };
}

/** Windows PowerShell's own AppUserModelId: a toast needs a registered application, and this one exists on every install. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TOAST_SCRIPT = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $template.GetElementsByTagName('text')",
  "$text.Item(0).AppendChild($template.CreateTextNode($env:PI_WARDEN_TITLE)) | Out-Null",
  "$text.Item(1).AppendChild($template.CreateTextNode($env:PI_WARDEN_BODY)) | Out-Null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
].join("; ");

/** Platform order: the native route first, then the desktop-agnostic tools, then the shells that reach another desktop (WSL). */
export function candidates(platform: NodeJS.Platform = process.platform): readonly Candidate[] {
  const pwshProbe = ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] as const;
  switch (platform) {
    case "darwin":
      return [{ name: "osascript", probe: { file: "osascript", args: ["-e", "return 0"] } }];
    case "win32":
      return [{ name: "powershell", probe: { file: "powershell", args: pwshProbe } }];
    default:
      return [
        { name: "notify-send", probe: { file: "notify-send", args: ["--version"] } },
        { name: "dunstify", probe: { file: "dunstify", args: ["--help"] } },
        { name: "gdbus", probe: { file: "gdbus", args: ["help"] } },
        { name: "kdialog", probe: { file: "kdialog", args: ["--version"] } },
        { name: "zenity", probe: { file: "zenity", args: ["--version"] } },
        // WSL: the Linux side has no notification daemon, but Windows PowerShell is on PATH and shows a toast.
        { name: "wsl-powershell", probe: { file: "powershell.exe", args: pwshProbe } },
      ];
  }
}

/** AppleScript string literal: only backslash and double quote need escaping. */
const appleScriptString = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
/** GVariant string literal for gdbus: single quotes with backslash escapes. */
const gvariantString = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A user-configured argv: `{title}` and `{body}` in any argument are replaced; the text is also in PI_WARDEN_TITLE / PI_WARDEN_BODY. */
export type NotifierTarget = NotifierName | readonly string[];

/** The command that shows one notification with the given tool. Text goes as arguments or environment, never through a shell. */
export function notifierCommand(target: NotifierTarget, notification: Notification): NotifierCommand {
  const { title, body } = notification;
  if (typeof target !== "string") {
    const [file = "", ...rest] = target;
    return { file, args: rest.map(arg => arg.replaceAll("{title}", title).replaceAll("{body}", body)), env: { PI_WARDEN_TITLE: title, PI_WARDEN_BODY: body } };
  }
  switch (target) {
    case "osascript":
      return { file: "osascript", args: ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)} sound name "Submarine"`] };
    case "notify-send":
      return { file: "notify-send", args: ["--app-name=pi-warden", "--urgency=critical", "--icon=dialog-warning", title, body] };
    case "dunstify":
      return { file: "dunstify", args: ["--appname=pi-warden", "--urgency=critical", title, body] };
    case "gdbus":
      return {
        file: "gdbus",
        args: ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.Notify",
          "pi-warden", "0", "dialog-warning", gvariantString(title), gvariantString(body), "[]", "{'urgency': <byte 2>}", "-1"],
      };
    case "kdialog":
      return { file: "kdialog", args: ["--title", title, "--passivepopup", body, "15"] };
    case "zenity":
      return { file: "zenity", args: ["--notification", `--text=${title}: ${body}`] };
    case "powershell":
    case "wsl-powershell":
      return {
        file: target === "powershell" ? "powershell" : "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", TOAST_SCRIPT],
        env: { PI_WARDEN_TITLE: title, PI_WARDEN_BODY: body },
      };
  }
}

export type Runner = (file: string, args: readonly string[], options: { timeoutMs: number; env?: Record<string, string> }) => Promise<boolean>;

/** Runs a command detached from the terminal; resolves to whether it exited cleanly. Never throws. */
export const run: Runner = (file, args, options) => new Promise(resolve => {
  try {
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    execFile(file, [...args], { timeout: options.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, env }, error => resolve(!error));
  } catch {
    resolve(false);
  }
});

/** First notifier whose probe answers on this machine, or undefined when the desktop cannot be reached. */
export async function detectNotifier(platform: NodeJS.Platform = process.platform, runner: Runner = run, timeoutMs = 3000): Promise<NotifierName | undefined> {
  for (const candidate of candidates(platform)) {
    if (await runner(candidate.probe.file, candidate.probe.args, { timeoutMs })) return candidate.name;
  }
  return undefined;
}

/** Notifications truncate around a hundred characters; keep the reason first. */
export function clipBody(text: string, limit = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export async function sendNotification(target: NotifierTarget, notification: Notification, runner: Runner = run, timeoutMs = 8000): Promise<boolean> {
  const command = notifierCommand(target, { title: notification.title, body: clipBody(notification.body) });
  if (!command.file) return false;
  return runner(command.file, command.args, { timeoutMs, ...(command.env ? { env: command.env } : {}) });
}
