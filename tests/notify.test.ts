import assert from "node:assert/strict";
import { test } from "node:test";
import { candidates, clipBody, detectNotifier, notifierCommand, sendNotification } from "../src/notify.js";
import type { Runner } from "../src/notify.js";

const note = { title: "pi-warden", body: 'Held bash: destructive: recursive rm on an absolute path. The agent will ask you in chat.' };

test("each platform has a native route first and the commands never go through a shell", () => {
  assert.deepEqual(candidates("darwin").map(c => c.name), ["osascript"]);
  assert.deepEqual(candidates("win32").map(c => c.name), ["powershell"]);
  assert.deepEqual(candidates("linux").map(c => c.name), ["notify-send", "dunstify", "gdbus", "kdialog", "zenity", "wsl-powershell"]);
  for (const platform of ["darwin", "win32", "linux"] as const) {
    for (const candidate of candidates(platform)) {
      const command = notifierCommand(candidate.name, note);
      assert.ok(command.file && !/[;&|`$]/.test(command.file), `${candidate.name} runs a plain executable`);
      assert.ok(command.args.length > 0);
    }
  }
});

test("AppleScript and GVariant literals escape quotes and backslashes; PowerShell gets the text through the environment", () => {
  const tricky = { title: 'a "quoted" \\ title', body: "it's \"done\"" };
  const apple = notifierCommand("osascript", tricky);
  assert.equal(apple.file, "osascript");
  assert.equal(apple.args[1], 'display notification "it\'s \\"done\\"" with title "a \\"quoted\\" \\\\ title" sound name "Submarine"');
  const dbus = notifierCommand("gdbus", tricky);
  assert.ok(dbus.args.includes("'a \"quoted\" \\\\ title'"));
  assert.ok(dbus.args.includes("'it\\'s \"done\"'"));
  const toast = notifierCommand("powershell", tricky);
  assert.equal(toast.file, "powershell");
  assert.deepEqual(toast.env, { PI_WARDEN_TITLE: tricky.title, PI_WARDEN_BODY: tricky.body });
  assert.ok(!toast.args.join(" ").includes("quoted"), "no user text inside the script");
  assert.match(toast.args.at(-1)!, /ToastNotificationManager.*\$env:PI_WARDEN_BODY/s);
  assert.equal(notifierCommand("wsl-powershell", tricky).file, "powershell.exe");
  const send = notifierCommand("notify-send", tricky);
  assert.deepEqual(send.args.slice(-2), [tricky.title, tricky.body], "title and body are separate arguments");
});

test("a configured command gets placeholders replaced and the text in the environment; an empty argv sends nothing", async () => {
  const custom = notifierCommand(["curl", "-d", "{body}", "-H", "Title: {title}", "https://ntfy.sh/topic"], note);
  assert.equal(custom.file, "curl");
  assert.deepEqual(custom.args, ["-d", note.body, "-H", `Title: ${note.title}`, "https://ntfy.sh/topic"]);
  assert.deepEqual(custom.env, { PI_WARDEN_TITLE: note.title, PI_WARDEN_BODY: note.body });
  const calls: string[] = [];
  const runner: Runner = async file => { calls.push(file); return true; };
  assert.equal(await sendNotification([], note, runner), false);
  assert.deepEqual(calls, []);
  assert.equal(await sendNotification(["my-notifier"], note, runner), true);
  assert.deepEqual(calls, ["my-notifier"]);
});

test("detection takes the first candidate whose probe answers, and none when the desktop is unreachable", async () => {
  const probed: string[] = [];
  const onlyZenity: Runner = async file => { probed.push(file); return file === "zenity"; };
  assert.equal(await detectNotifier("linux", onlyZenity), "zenity");
  assert.deepEqual(probed, ["notify-send", "dunstify", "gdbus", "kdialog", "zenity"]);
  assert.equal(await detectNotifier("linux", async () => false), undefined);
  assert.equal(await detectNotifier("darwin", async () => true), "osascript");
  const throwing: Runner = async () => { throw new Error("probe exploded"); };
  await assert.rejects(detectNotifier("darwin", throwing), /probe exploded/, "the runner contract is to resolve false, so a throw is the caller's bug to see");
});

test("sendNotification clips the body and reports the exit", async () => {
  let seen: readonly string[] = [];
  const runner: Runner = async (_file, args) => { seen = args; return true; };
  assert.equal(await sendNotification("notify-send", { title: "t", body: `${"x".repeat(300)}\n\nmore` }, runner), true);
  assert.equal(seen.at(-1)!.length, 180);
  assert.ok(seen.at(-1)!.endsWith("…"));
  assert.equal(clipBody("  a   b\nc "), "a b c");
});
