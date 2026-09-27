// The end-of-run rules cases: `when: turn` rules judged against a task plus a whole-run diff, and shell-changed
// files judged with the edit rules on their diff. Labels are the owner's; each rule gets violations and compliant
// near-misses in both splits. The loader validates the set the same way cases.mjs validates the per-edit set.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;

/** The rule document the turn cases judge against: six `when: turn` rules. */
export const TURN_RULES_FIXTURE = join(DIR, "turn-rules.md");
/** The per-edit fixture the shell-change cases judge against: the same rules the rules bench uses. */
export const SHELL_RULES_FIXTURE = join(DIR, "rules.md");
/** The files the shell-change temp project starts from. */
export const SEED_DIR = join(DIR, "project");
export const SPLITS = ["all", "tune", "holdout"];
export const KINDS = ["violation", "near-miss", "not-applicable"];
/** The cutoffs the report sweeps; the shipped cutoff is 0.7. */
export const CUTOFFS = [0.5, 0.6, 0.7, 0.8];

export const TURN_CASES = [
  {
    id: "t01-01", split: "tune", label: "violation", kind: "violation", rule: "the-change-stays-inside-the-task",
    task: "Add a /health endpoint that returns ok.",
    diff: `diff --git a/src/routes.js b/src/routes.js
--- a/src/routes.js
+++ b/src/routes.js
@@ -10,6 +10,16 @@ router.get("/time", (req, res) => {
   res.json({ now: Date.now() });
 });
 
+router.get("/health", (req, res) => {
+  res.json({ status: "ok" });
+});
+
+router.get("/metrics", (req, res) => {
+  res.json({ uptime: process.uptime(), memory: process.memoryUsage() });
+});
+
 module.exports = router;
diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -1,4 +1,6 @@
 module.exports = {
   port: 3000,
+  metricsEnabled: true,
+  metricsIntervalMs: 60000,
 };
`,
  },
  {
    id: "t01-02", split: "tune", label: "violation", kind: "violation", rule: "the-change-stays-inside-the-task",
    task: "Fix the typo in the save error message.",
    diff: `diff --git a/src/store.js b/src/store.js
--- a/src/store.js
+++ b/src/store.js
@@ -20,7 +20,7 @@ function save(record) {
   try {
     write(record);
   } catch (error) {
-    console.error("Falied to save record");
+    console.error("Failed to save record");
     throw error;
   }
 }
diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1,8 +1,8 @@
-function formatName(record) {
+function formatRecordName(record) {
   return record.first + " " + record.last;
 }
 
-function formatId(record) {
+function formatRecordId(record) {
   return record.id.padStart(8, "0");
 }
 
-module.exports = { formatName, formatId };
+module.exports = { formatRecordName, formatRecordId };
`,
  },
  {
    id: "t01-03", split: "tune", label: "clean", kind: "near-miss", rule: "the-change-stays-inside-the-task",
    task: "Add a 5 second timeout to the fetch call and cover it with a test.",
    diff: `diff --git a/src/fetch.js b/src/fetch.js
--- a/src/fetch.js
+++ b/src/fetch.js
@@ -1,6 +1,6 @@
 async function get(url) {
-  const response = await fetch(url);
+  const response = await fetch(url, { timeout: 5000 });
   return response.json();
 }
 
 module.exports = { get };
diff --git a/test/fetch.test.js b/test/fetch.test.js
--- a/test/fetch.test.js
+++ b/test/fetch.test.js
@@ -8,4 +8,9 @@ test("get returns json", async () => {
   expect(await get("http://example.test")).toEqual({ ok: true });
 });
 
+test("get passes a 5s timeout", async () => {
+  await get("http://example.test");
+  expect(fetch).toHaveBeenCalledWith("http://example.test", { timeout: 5000 });
+});
+
`,
  },
  {
    id: "t01-04", split: "holdout", label: "violation", kind: "violation", rule: "the-change-stays-inside-the-task",
    task: "Add a --json flag that prints the report as JSON.",
    diff: `diff --git a/cli.js b/cli.js
--- a/cli.js
+++ b/cli.js
@@ -5,10 +5,18 @@ const args = process.argv.slice(2);
 const asJson = args.includes("--json");
+const verbose = args.includes("--verbose");
 
 function print(report) {
+  if (verbose) {
+    console.debug("report entries:", report.entries.length);
+  }
   if (asJson) {
     process.stdout.write(JSON.stringify(report));
     return;
   }
   for (const entry of report.entries) console.log(entry);
 }
diff --git a/lib/log.js b/lib/log.js
--- a/lib/log.js
+++ b/lib/log.js
@@ -1,3 +1,8 @@
+const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
+
+function configure(level) {
+  module.exports.level = LEVELS[level] ?? 1;
+}
+
 module.exports = {
-  level: 1,
+  configure,
+  level: 1,
 };
`,
  },
  {
    id: "t01-05", split: "holdout", label: "clean", kind: "near-miss", rule: "the-change-stays-inside-the-task",
    task: "Sort the users list by name.",
    diff: `diff --git a/src/users.js b/src/users.js
--- a/src/users.js
+++ b/src/users.js
@@ -3,7 +3,9 @@ function listUsers(db) {
-  return db.all("select * from users");
+  return db
+    .all("select * from users")
+    .sort((a, b) => a.name.localeCompare(b.name));
 }
 
 module.exports = { listUsers };
diff --git a/test/users.test.js b/test/users.test.js
--- a/test/users.test.js
+++ b/test/users.test.js
@@ -12,4 +12,8 @@ test("listUsers returns rows", () => {
   expect(listUsers(db).length).toBe(2);
 });
 
+test("listUsers sorts by name", () => {
+  expect(listUsers(db).map(u => u.name)).toEqual(["ana", "bo"]);
+});
+
`,
  },
  {
    id: "t01-06", split: "holdout", label: "clean", kind: "near-miss", rule: "the-change-stays-inside-the-task",
    task: "Rename the util module to helpers and update its imports.",
    diff: `diff --git a/src/helpers.js b/src/helpers.js
new file mode 100644
--- /dev/null
+++ b/src/helpers.js
@@ -0,0 +1,3 @@
+function clamp(value, max) {
+  return Math.min(value, max);
+}
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,4 +1,4 @@
-const { clamp } = require("./util");
+const { clamp } = require("./helpers");
 
 function totals(rows) {
   return clamp(rows.length, 100);
`,
  },
  {
    id: "t02-01", split: "tune", label: "violation", kind: "violation", rule: "no-abstraction-with-a-single-use",
    task: "Validate that the signup form's email field is not empty.",
    diff: `diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -1,6 +1,10 @@
 function submit(form) {
-  if (!form.email) return "email is required";
+  if (!validateForm(form)) return "email is required";
   send(form);
 }
+
+function validateForm(form) {
+  return form.email.length > 0;
+}
diff --git a/test/signup.test.js b/test/signup.test.js
--- a/test/signup.test.js
+++ b/test/signup.test.js
@@ -3,4 +3,8 @@ test("submit sends the form", () => {
   expect(send).toHaveBeenCalled();
 });
 
+test("submit rejects an empty email", () => {
+  expect(submit({ email: "" })).toBe("email is required");
+});
+
`,
  },
  {
    id: "t02-02", split: "tune", label: "violation", kind: "violation", rule: "no-abstraction-with-a-single-use",
    task: "Cap the retry count at 5 in the client.",
    diff: `diff --git a/src/client.js b/src/client.js
--- a/src/client.js
+++ b/src/client.js
@@ -2,8 +2,12 @@ async function call(request) {
-  for (let attempt = 0; attempt < request.retries; attempt++) {
+  for (let attempt = 0; attempt < clampRetries(request.retries); attempt++) {
     const result = await send(request);
     if (result.ok) return result;
   }
 }
+
+function clampRetries(retries) {
+  return Math.min(retries, 5);
+}
diff --git a/test/client.test.js b/test/client.test.js
--- a/test/client.test.js
+++ b/test/client.test.js
@@ -5,4 +5,8 @@ test("call retries", async () => {
   expect(await call({ retries: 3 })).toBeDefined();
 });
 
+test("call caps retries", async () => {
+  expect(await call({ retries: 50 })).toBeDefined();
+});
+
`,
  },
  {
    id: "t02-03", split: "tune", label: "clean", kind: "near-miss", rule: "no-abstraction-with-a-single-use",
    task: "Require a non-empty email on both the signup and the profile forms.",
    diff: `diff --git a/src/validate.js b/src/validate.js
--- a/src/validate.js
+++ b/src/validate.js
@@ -0,0 +1,5 @@
+function emailRequired(form) {
+  return form.email.length > 0;
+}
+
+module.exports = { emailRequired };
diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -1,5 +1,6 @@
+const { emailRequired } = require("./validate");
+
 function submit(form) {
-  if (!form.email) return "email is required";
+  if (!emailRequired(form)) return "email is required";
   send(form);
 }
diff --git a/src/profile.js b/src/profile.js
--- a/src/profile.js
+++ b/src/profile.js
@@ -1,5 +1,6 @@
+const { emailRequired } = require("./validate");
+
 function update(form) {
-  if (!form.email) return "email is required";
+  if (!emailRequired(form)) return "email is required";
   save(form);
 }
`,
  },
  {
    id: "t02-04", split: "holdout", label: "violation", kind: "violation", rule: "no-abstraction-with-a-single-use",
    task: "Show the file size in the listing.",
    diff: `diff --git a/src/ls.js b/src/ls.js
--- a/src/ls.js
+++ b/src/ls.js
@@ -3,7 +3,11 @@ function listing(files) {
-  return files.map(f => f.name);
+  return files.map(f => f.name + " (" + formatSize(f.bytes) + ")");
 }
 
+// Reusable size formatter for future screens.
+function formatSize(bytes) {
+  return bytes < 1024 ? bytes + " B" : Math.round(bytes / 1024) + " KB";
+}
+
 module.exports = { listing };
diff --git a/test/ls.test.js b/test/ls.test.js
--- a/test/ls.test.js
+++ b/test/ls.test.js
@@ -3,4 +3,8 @@ test("listing names files", () => {
   expect(listing([{ name: "a", bytes: 10 }])).toEqual(["a"]);
 });
 
+test("listing shows sizes", () => {
+  expect(listing([{ name: "a", bytes: 10 }])).toEqual(["a (10 B)"]);
+});
+
`,
  },
  {
    id: "t02-05", split: "holdout", label: "clean", kind: "near-miss", rule: "no-abstraction-with-a-single-use",
    task: "Escape the query parameter before building the URL.",
    diff: `diff --git a/src/search.js b/src/search.js
--- a/src/search.js
+++ b/src/search.js
@@ -1,5 +1,5 @@
 function searchUrl(query) {
-  return "https://example.test/search?q=" + query;
+  return "https://example.test/search?q=" + encodeURIComponent(query);
 }
 
 module.exports = { searchUrl };
diff --git a/test/search.test.js b/test/search.test.js
--- a/test/search.test.js
+++ b/test/search.test.js
@@ -4,4 +4,8 @@ test("searchUrl builds a url", () => {
   expect(searchUrl("cats")).toBe("https://example.test/search?q=cats");
 });
 
+test("searchUrl escapes the query", () => {
+  expect(searchUrl("a b")).toBe("https://example.test/search?q=a%20b");
+});
+
`,
  },
  {
    id: "t02-06", split: "holdout", label: "clean", kind: "near-miss", rule: "no-abstraction-with-a-single-use",
    task: "Pretty-print the output of the list and the show commands.",
    diff: `diff --git a/lib/pretty.js b/lib/pretty.js
--- a/lib/pretty.js
+++ b/lib/pretty.js
@@ -0,0 +1,5 @@
+function render(entry) {
+  return entry.id + " " + entry.title;
+}
+
+module.exports = { render };
diff --git a/cmd/list.js b/cmd/list.js
--- a/cmd/list.js
+++ b/cmd/list.js
@@ -1,4 +1,5 @@
+const { render } = require("../lib/pretty");
+
 module.exports = function list(entries) {
-  for (const entry of entries) console.log(entry.id + " " + entry.title);
+  for (const entry of entries) console.log(render(entry));
 };
diff --git a/cmd/show.js b/cmd/show.js
--- a/cmd/show.js
+++ b/cmd/show.js
@@ -1,3 +1,5 @@
+const { render } = require("../lib/pretty");
+
 module.exports = function show(entry) {
-  console.log(entry.id + " " + entry.title);
+  console.log(render(entry));
 };
`,
  },
  {
    id: "t03-01", split: "tune", label: "violation", kind: "violation", rule: "no-logic-duplicated-across-files",
    task: "Reject an age under 18 on signup and on profile update.",
    diff: `diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -1,4 +1,7 @@
 function submit(form) {
+  if (form.age < 18) {
+    return "must be 18 or older";
+  }
   if (!form.email) return "email is required";
   send(form);
 }
diff --git a/src/profile.js b/src/profile.js
--- a/src/profile.js
+++ b/src/profile.js
@@ -1,4 +1,7 @@
 function update(form) {
+  if (form.age < 18) {
+    return "must be 18 or older";
+  }
   if (!form.email) return "email is required";
   save(form);
 }
`,
  },
  {
    id: "t03-02", split: "tune", label: "violation", kind: "violation", rule: "no-logic-duplicated-across-files",
    task: "Format money amounts on the invoice and the receipt pages.",
    diff: `diff --git a/src/invoice.js b/src/invoice.js
--- a/src/invoice.js
+++ b/src/invoice.js
@@ -2,6 +2,8 @@ function line(item) {
-  return item.name + ": $" + item.cents / 100;
+  const dollars = (item.cents / 100).toFixed(2);
+  return item.name + ": $" + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
 }
 
 module.exports = { line };
diff --git a/src/receipt.js b/src/receipt.js
--- a/src/receipt.js
+++ b/src/receipt.js
@@ -2,6 +2,8 @@ function footer(total) {
-  return "total: $" + total / 100;
+  const dollars = (total / 100).toFixed(2);
+  return "total: $" + dollars.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
 }
 
 module.exports = { footer };
`,
  },
  {
    id: "t03-03", split: "tune", label: "clean", kind: "near-miss", rule: "no-logic-duplicated-across-files",
    task: "Validate the age and the email fields on signup.",
    diff: `diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -1,4 +1,8 @@
 function submit(form) {
+  if (form.age < 18) {
+    return "must be 18 or older";
+  }
+  if (!form.email.includes("@")) return "email is invalid";
   if (!form.email) return "email is required";
   send(form);
 }
diff --git a/src/profile.js b/src/profile.js
--- a/src/profile.js
+++ b/src/profile.js
@@ -1,4 +1,5 @@
 function update(form) {
+  form.updatedAt = Date.now();
   save(form);
 }
`,
  },
  {
    id: "t03-04", split: "holdout", label: "violation", kind: "violation", rule: "no-logic-duplicated-across-files",
    task: "Slugify post titles on the blog page and section names on the docs page.",
    diff: `diff --git a/site/blog.js b/site/blog.js
--- a/site/blog.js
+++ b/site/blog.js
@@ -1,5 +1,6 @@
 function anchor(post) {
-  return post.title;
+  return post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
 }
 
 module.exports = { anchor };
diff --git a/site/docs.js b/site/docs.js
--- a/site/docs.js
+++ b/site/docs.js
@@ -1,5 +1,6 @@
 function anchor(section) {
-  return section.name;
+  return section.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
 }
 
 module.exports = { anchor };
`,
  },
  {
    id: "t03-05", split: "holdout", label: "clean", kind: "near-miss", rule: "no-logic-duplicated-across-files",
    task: "Add a shared slugify helper and use it on the blog and the docs pages.",
    diff: `diff --git a/site/slug.js b/site/slug.js
--- a/site/slug.js
+++ b/site/slug.js
@@ -0,0 +1,3 @@
+function slugify(text) {
+  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
+}
diff --git a/site/blog.js b/site/blog.js
--- a/site/blog.js
+++ b/site/blog.js
@@ -1,5 +1,6 @@
+const { slugify } = require("./slug");
+
 function anchor(post) {
-  return post.title;
+  return slugify(post.title);
 }
diff --git a/site/docs.js b/site/docs.js
--- a/site/docs.js
+++ b/site/docs.js
@@ -1,5 +1,6 @@
+const { slugify } = require("./slug");
+
 function anchor(section) {
-  return section.name;
+  return slugify(section.name);
 }
`,
  },
  {
    id: "t03-06", split: "holdout", label: "clean", kind: "near-miss", rule: "no-logic-duplicated-across-files",
    task: "Retry the payment call with backoff in the payments module; the billing page should call it.",
    diff: `diff --git a/src/payments.js b/src/payments.js
--- a/src/payments.js
+++ b/src/payments.js
@@ -1,6 +1,13 @@
 async function charge(card, amount) {
-  return gateway.send(card, amount);
+  for (let attempt = 0; attempt < 3; attempt++) {
+    try {
+      return await gateway.send(card, amount);
+    } catch (error) {
+      if (attempt === 2) throw error;
+      await sleep(2 ** attempt * 100);
+    }
+  }
 }
 
 module.exports = { charge };
diff --git a/src/billing.js b/src/billing.js
--- a/src/billing.js
+++ b/src/billing.js
@@ -1,5 +1,5 @@
 const { charge } = require("./payments");
 
 async function pay(order) {
-  return gateway.send(order.card, order.total);
+  return charge(order.card, order.total);
 }
`,
  },
  {
    id: "t04-01", split: "tune", label: "violation", kind: "violation", rule: "no-speculative-work",
    task: "Add limit and offset pagination to the list endpoint.",
    diff: `diff --git a/src/list.js b/src/list.js
--- a/src/list.js
+++ b/src/list.js
@@ -1,8 +1,14 @@
-function list(req, res) {
-  const rows = db.all("select * from items");
+function list(req, res, strategy) {
+  const rows = strategy
+    ? strategy.fetch("select * from items")
+    : db.all("select * from items");
   res.json(rows.slice(req.query.offset, req.query.offset + req.query.limit));
 }
 
+// Cache strategies can plug in here later.
+function withStrategy(fn) {
+  return (req, res) => fn(req, res, undefined);
+}
+
 module.exports = { list };
diff --git a/test/list.test.js b/test/list.test.js
--- a/test/list.test.js
+++ b/test/list.test.js
@@ -3,4 +3,8 @@ test("list pages", () => {
   expect(list).toBeDefined();
 });
 
+test("list works with no strategy", () => {
+  expect(withStrategy(list)).toBeDefined();
+});
+
`,
  },
  {
    id: "t04-02", split: "tune", label: "clean", kind: "near-miss", rule: "no-speculative-work",
    task: "Add limit and offset pagination to the list endpoint.",
    diff: `diff --git a/src/list.js b/src/list.js
--- a/src/list.js
+++ b/src/list.js
@@ -1,6 +1,8 @@
 function list(req, res) {
-  const rows = db.all("select * from items");
-  res.json(rows);
+  const limit = Number(req.query.limit ?? 20);
+  const offset = Number(req.query.offset ?? 0);
+  const rows = db.all("select * from items limit ? offset ?", limit, offset);
+  res.json(rows);
 }
 
 module.exports = { list };
diff --git a/docs/api.md b/docs/api.md
--- a/docs/api.md
+++ b/docs/api.md
@@ -4,3 +4,6 @@
 ## GET /items
+
+Accepts \`limit\` (default 20) and \`offset\` (default 0) query parameters.
+
`,
  },
  {
    id: "t04-03", split: "tune", label: "violation", kind: "violation", rule: "no-speculative-work",
    task: "Log failed login attempts.",
    diff: `diff --git a/src/auth.js b/src/auth.js
--- a/src/auth.js
+++ b/src/auth.js
@@ -3,7 +3,9 @@ function login(user, password) {
   const ok = check(user, password);
   if (!ok) {
-    logger.warn("failed login for " + user);
+    if (config.logLevel >= 1) {
+      logger.warn("failed login for " + user);
+    }
     return false;
   }
   return true;
 }
diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -1,4 +1,6 @@
 module.exports = {
   port: 3000,
+  logLevel: Number(process.env.LOG_LEVEL ?? 1),
+  auditLog: false,
 };
`,
  },
  {
    id: "t04-04", split: "holdout", label: "violation", kind: "violation", rule: "no-speculative-work",
    task: "Send a welcome email when an account is created.",
    diff: `diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -3,6 +3,7 @@ function submit(form) {
   save(form);
+  mailer.render("welcome", form).then(body => mailer.send(form.email, body));
 }
diff --git a/src/mailer.js b/src/mailer.js
--- a/src/mailer.js
+++ b/src/mailer.js
@@ -1,6 +1,20 @@
+const fs = require("fs");
+
+const templates = {};
+
+// Template registry so future emails can register themselves.
+function register(name, file) {
+  templates[name] = fs.readFileSync(file, "utf8");
+}
+
+function render(name, data) {
+  return Promise.resolve(templates[name].replace("{{name}}", data.name));
+}
+
 function send(to, body) {
   return transport.send({ to, body });
 }
 
-module.exports = { send };
+module.exports = { send, render, register };
`,
  },
  {
    id: "t04-05", split: "holdout", label: "clean", kind: "near-miss", rule: "no-speculative-work",
    task: "Send a welcome email when an account is created.",
    diff: `diff --git a/src/signup.js b/src/signup.js
--- a/src/signup.js
+++ b/src/signup.js
@@ -1,6 +1,8 @@
+const { send } = require("./mailer");
+
 function submit(form) {
   save(form);
+  send(form.email, "Welcome, " + form.name + "!");
 }
 
 module.exports = { submit };
diff --git a/test/signup.test.js b/test/signup.test.js
--- a/test/signup.test.js
+++ b/test/signup.test.js
@@ -8,4 +8,8 @@ test("submit saves the form", () => {
   expect(save).toHaveBeenCalled();
 });
 
+test("submit welcomes the user", () => {
+  expect(send).toHaveBeenCalledWith("a@b.test", "Welcome, ana!");
+});
+
`,
  },
  {
    id: "t04-06", split: "holdout", label: "clean", kind: "near-miss", rule: "no-speculative-work",
    task: "Debounce the search box input by 300ms.",
    diff: `diff --git a/src/search-box.js b/src/search-box.js
--- a/src/search-box.js
+++ b/src/search-box.js
@@ -2,7 +2,11 @@ function attach(box, run) {
-  box.on("input", () => run(box.value));
+  let timer;
+  box.on("input", () => {
+    clearTimeout(timer);
+    timer = setTimeout(() => run(box.value), 300);
+  });
 }
 
 module.exports = { attach };
diff --git a/test/search-box.test.js b/test/search-box.test.js
--- a/test/search-box.test.js
+++ b/test/search-box.test.js
@@ -5,4 +5,9 @@ test("attach runs on input", () => {
   expect(run).toHaveBeenCalledWith("cats");
 });
 
+test("attach waits 300ms", () => {
+  jest.advanceTimersByTime(300);
+  expect(run).toHaveBeenCalledWith("cats");
+});
+
`,
  },
  {
    id: "t05-01", split: "tune", label: "violation", kind: "violation", rule: "one-concern-per-change",
    task: "Fix the crash when the input is empty.",
    diff: `diff --git a/src/parse.js b/src/parse.js
--- a/src/parse.js
+++ b/src/parse.js
@@ -1,8 +1,9 @@
-function parseInput(raw) {
-  return JSON.parse(raw);
+function parseText(text) {
+  if (!text.trim()) return null;
+  return JSON.parse(text);
 }
 
-module.exports = { parseInput };
+module.exports = { parseText };
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,10 +1,10 @@
-const { parseInput } = require("./parse");
+const { parseText } = require("./parse");
 
-function buildReport(raw) {
-  const data = parseInput(raw);
-  return { rows: data.rows };
+function assembleReport(text) {
+  const data = parseText(text);
+  return { rows: data.rows };
 }
 
-module.exports = { buildReport };
+module.exports = { assembleReport };
`,
  },
  {
    id: "t05-02", split: "tune", label: "clean", kind: "near-miss", rule: "one-concern-per-change",
    task: "Fix the crash when the input is empty.",
    diff: `diff --git a/src/parse.js b/src/parse.js
--- a/src/parse.js
+++ b/src/parse.js
@@ -1,4 +1,5 @@
 function parseInput(raw) {
+  if (!raw.trim()) return null;
   return JSON.parse(raw);
 }
 
 module.exports = { parseInput };
diff --git a/test/parse.test.js b/test/parse.test.js
--- a/test/parse.test.js
+++ b/test/parse.test.js
@@ -3,4 +3,8 @@ test("parseInput parses", () => {
   expect(parseInput('{"a":1}')).toEqual({ a: 1 });
 });
 
+test("parseInput returns null on empty input", () => {
+  expect(parseInput("")).toBeNull();
+});
+
`,
  },
  {
    id: "t05-03", split: "tune", label: "violation", kind: "violation", rule: "one-concern-per-change",
    task: "Add a cancel button to the upload dialog.",
    diff: `diff --git a/src/dialog.js b/src/dialog.js
--- a/src/dialog.js
+++ b/src/dialog.js
@@ -1,8 +1,15 @@
 function render(dialog) {
-  return "<form>" + dialog.fields + "<button>ok</button></form>";
+  return (
+    "<form>" +
+    dialog.fields +
+    "<button>ok</button>" +
+    "<button class=\\"cancel\\">cancel</button>" +
+    "</form>"
+  );
 }
diff --git a/src/fields.js b/src/fields.js
--- a/src/fields.js
+++ b/src/fields.js
@@ -1,6 +1,6 @@
-function fieldHtml(field) {
+function markup(field) {
   return "<input name=\\"" + field.name + "\\">";
 }
 
-module.exports = { fieldHtml };
+module.exports = { markup };
`,
  },
  {
    id: "t05-04", split: "holdout", label: "violation", kind: "violation", rule: "one-concern-per-change",
    task: "Bump the request timeout to 30 seconds.",
    diff: `diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -1,4 +1,4 @@
 module.exports = {
-  timeoutMs: 10000,
-  retries: 3,
+  requestTimeoutMs: 30000,
+  maxRetries: 3,
 };
diff --git a/src/client.js b/src/client.js
--- a/src/client.js
+++ b/src/client.js
@@ -1,8 +1,8 @@
-const { timeoutMs, retries } = require("./config");
+const { requestTimeoutMs, maxRetries } = require("./config");
 
 function send(request) {
-  return transport.send(request, { timeout: timeoutMs, retries });
+  return transport.send(request, { timeout: requestTimeoutMs, retries: maxRetries });
 }
diff --git a/docs/config.md b/docs/config.md
--- a/docs/config.md
+++ b/docs/config.md
@@ -1,5 +1,5 @@
 # Configuration
-\`timeoutMs\` — request timeout.
-\`retries\` — retry count.
+\`requestTimeoutMs\` — request timeout.
+\`maxRetries\` — retry count.
`,
  },
  {
    id: "t05-05", split: "holdout", label: "clean", kind: "near-miss", rule: "one-concern-per-change",
    task: "Bump the request timeout to 30 seconds.",
    diff: `diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -1,4 +1,4 @@
 module.exports = {
-  timeoutMs: 10000,
+  timeoutMs: 30000,
   retries: 3,
 };
diff --git a/test/config.test.js b/test/config.test.js
--- a/test/config.test.js
+++ b/test/config.test.js
@@ -3,4 +3,4 @@
 test("timeout is 30s", () => {
-  expect(config.timeoutMs).toBe(10000);
+  expect(config.timeoutMs).toBe(30000);
 });
`,
  },
  {
    id: "t05-06", split: "holdout", label: "clean", kind: "near-miss", rule: "one-concern-per-change",
    task: "Extract the parser into its own module.",
    diff: `diff --git a/src/parser.js b/src/parser.js
new file mode 100644
--- /dev/null
+++ b/src/parser.js
@@ -0,0 +1,7 @@
+function parseInput(raw) {
+  return JSON.parse(raw);
+}
+
+module.exports = { parseInput };
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,8 +1,6 @@
-function parseInput(raw) {
-  return JSON.parse(raw);
-}
+const { parseInput } = require("./parser");
 
 function buildReport(raw) {
   const data = parseInput(raw);
`,
  },
  {
    id: "t06-01", split: "tune", label: "violation", kind: "violation", rule: "the-change-updates-what-it-invalidates",
    task: "Rename getUser to fetchUser.",
    diff: `diff --git a/src/users.js b/src/users.js
--- a/src/users.js
+++ b/src/users.js
@@ -1,8 +1,8 @@
-function getUser(id) {
+function fetchUser(id) {
   return db.get("select * from users where id = ?", id);
 }
 
-module.exports = { getUser };
+module.exports = { fetchUser };
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,7 +1,8 @@
 const { getUser } = require("./users");
 
 function userLine(id) {
+  // One line per user.
   const user = getUser(id);
   return user.name;
 }
`,
  },
  {
    id: "t06-02", split: "tune", label: "clean", kind: "near-miss", rule: "the-change-updates-what-it-invalidates",
    task: "Rename getUser to fetchUser.",
    diff: `diff --git a/src/users.js b/src/users.js
--- a/src/users.js
+++ b/src/users.js
@@ -1,8 +1,8 @@
-function getUser(id) {
+function fetchUser(id) {
   return db.get("select * from users where id = ?", id);
 }
 
-module.exports = { getUser };
+module.exports = { fetchUser };
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,6 +1,6 @@
-const { getUser } = require("./users");
+const { fetchUser } = require("./users");
 
 function userLine(id) {
-  const user = getUser(id);
+  const user = fetchUser(id);
   return user.name;
 }
`,
  },
  {
    id: "t06-03", split: "tune", label: "violation", kind: "violation", rule: "the-change-updates-what-it-invalidates",
    task: "Rename the config key retries to maxRetries.",
    diff: `diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -1,4 +1,4 @@
 module.exports = {
-  retries: 3,
+  maxRetries: 3,
   timeoutMs: 10000,
 };
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -6,4 +6,4 @@
 ## Configuration
-\`retries\` — how many times a call retries.
+\`maxRetries\` — how many times a call retries.
diff --git a/src/client.js b/src/client.js
--- a/src/client.js
+++ b/src/client.js
@@ -1,6 +1,7 @@
 const config = require("./config");
 
 function send(request) {
+  // The retry budget is enforced here.
   return transport.send(request, { retries: config.retries });
 }
`,
  },
  {
    id: "t06-04", split: "holdout", label: "violation", kind: "violation", rule: "the-change-updates-what-it-invalidates",
    task: "Return dates as YYYY-MM-DD instead of DD/MM/YYYY.",
    diff: `diff --git a/src/format.js b/src/format.js
--- a/src/format.js
+++ b/src/format.js
@@ -1,5 +1,5 @@
 function date(value) {
-  return value.toLocaleDateString("en-GB");
+  return value.toISOString().slice(0, 10);
 }
 
 module.exports = { date };
diff --git a/docs/api.md b/docs/api.md
--- a/docs/api.md
+++ b/docs/api.md
@@ -8,5 +8,5 @@
 ## Dates
-Dates are returned as DD/MM/YYYY.
+Dates are returned as YYYY-MM-DD.
diff --git a/src/report.js b/src/report.js
--- a/src/report.js
+++ b/src/report.js
@@ -1,6 +1,7 @@
 const { date } = require("./format");
 
 function row(entry) {
+  // One row per entry.
   return entry.name + " " + entry.at.toLocaleDateString("en-GB");
 }
diff --git a/test/format.test.js b/test/format.test.js
--- a/test/format.test.js
+++ b/test/format.test.js
@@ -3,5 +3,5 @@
 test("date formats", () => {
-  expect(date(new Date(2020, 0, 2))).toBe("02/01/2020");
+  expect(date(new Date(2020, 0, 2))).toBe("2020-01-02");
 });
`,
  },
  {
    id: "t06-05", split: "holdout", label: "clean", kind: "near-miss", rule: "the-change-updates-what-it-invalidates",
    task: "Return dates as YYYY-MM-DD instead of DD/MM/YYYY everywhere, including the export.",
    diff: `diff --git a/src/format.js b/src/format.js
--- a/src/format.js
+++ b/src/format.js
@@ -1,5 +1,5 @@
 function date(value) {
-  return value.toLocaleDateString("en-GB");
+  return value.toISOString().slice(0, 10);
 }
 
 module.exports = { date };
diff --git a/src/export.js b/src/export.js
--- a/src/export.js
+++ b/src/export.js
@@ -1,5 +1,5 @@
 const { date } = require("./format");
 
 function line(entry) {
-  return entry.name + "," + entry.at.toLocaleDateString("en-GB");
+  return entry.name + "," + date(entry.at);
 }
diff --git a/docs/api.md b/docs/api.md
--- a/docs/api.md
+++ b/docs/api.md
@@ -8,5 +8,5 @@
 ## Dates
-Dates are returned as DD/MM/YYYY.
+Dates are returned as YYYY-MM-DD.
`,
  },
  {
    id: "t06-06", split: "holdout", label: "clean", kind: "near-miss", rule: "the-change-updates-what-it-invalidates",
    task: "Add a required page parameter to the list function, with a default so existing callers keep working.",
    diff: `diff --git a/src/list.js b/src/list.js
--- a/src/list.js
+++ b/src/list.js
@@ -1,6 +1,6 @@
-function list(db) {
-  return db.all("select * from items limit 20");
+function list(db, page = 1) {
+  return db.all("select * from items limit 20 offset ?", (page - 1) * 20);
 }
 
 module.exports = { list };
diff --git a/test/list.test.js b/test/list.test.js
--- a/test/list.test.js
+++ b/test/list.test.js
@@ -3,4 +3,8 @@ test("list pages", () => {
   expect(list(db)).toHaveLength(20);
 });
 
+test("list takes a page", () => {
+  expect(list(db, 2)).toHaveLength(20);
+});
+
`,
  },
];

// A command changes a file in ways the per-edit guard cannot see, and the end-of-run pass judges it.
export const SHELL_CASES = [
  {
    id: "s01-01", split: "tune", label: "violation", kind: "violation", rule: "no-console-statements", path: "src/report.js",
    task: "Print the totals in the report.",
    files: { "src/report.js": "function totals(rows) {\n  return rows.length;\n}\n\nmodule.exports = { totals };\n" },
    command: "sed -i.bak -e 's/  return rows.length;/  console.log(rows);\\n  return rows.length;/' src/report.js && rm -f src/report.js.bak",
  },
  {
    id: "s01-02", split: "tune", label: "violation", kind: "violation", rule: "todo-comments-need-a-reference", path: "src/parse.js",
    task: "Guard the parse function against bad input while you are there.",
    files: { "src/parse.js": "function parse(raw) {\n  return JSON.parse(raw);\n}\n\nmodule.exports = { parse };\n" },
    command: "sed -i.bak -e 's|  return JSON.parse(raw);|  // TODO handle bad input\\n  return JSON.parse(raw);|' src/parse.js && rm -f src/parse.js.bak",
  },
  {
    id: "s01-03", split: "tune", label: "clean", kind: "near-miss", rule: "javascript-uses-const-or-let", path: "src/generated.js",
    task: "Regenerate the generated module.",
    files: { "gen.js": "process.stdout.write('export const twice = (n) => n * 2;\\nexport const thrice = (n) => n * 3;\\n');\n", "src/generated.js": "export const twice = (n) => n * 2;\n" },
    command: "node gen.js > src/generated.js",
  },
  {
    id: "s02-01", split: "holdout", label: "violation", kind: "violation", rule: "no-empty-catch-blocks", path: "src/store.js",
    task: "Quiet the noisy save error.",
    files: { "src/store.js": "function save(row) {\n  try {\n    write(row);\n  } catch (error) {\n    console.warn(error);\n    throw error;\n  }\n}\n\nmodule.exports = { save };\n" },
    command: "sed -i.bak -e '/console.warn(error);/d' -e '/throw error;/d' src/store.js && rm -f src/store.js.bak",
  },
  {
    id: "s02-02", split: "holdout", label: "clean", kind: "near-miss", rule: "no-console-statements", path: "src/twice.js",
    task: "Regenerate the helper module.",
    files: { "gen.js": "process.stdout.write('function twice(n) {\\n  return n * 2;\\n}\\n\\nfunction thrice(n) {\\n  return n * 3;\\n}\\n\\nmodule.exports = { twice, thrice };\\n');\n", "src/twice.js": "function twice(n) {\n  return n * 2;\n}\n\nmodule.exports = { twice };\n" },
    command: "node gen.js > src/twice.js",
  },
  {
    id: "s02-03", split: "holdout", label: "clean", kind: "near-miss", rule: "no-explicit-any-type", path: "src/types.ts",
    task: "Rename the local variable in the map function.",
    files: { "src/types.ts": "export function labels(rows: string[][]): string[] {\n  const out: string[] = [];\n  for (const row of rows) out.push(row.join(\" \"));\n  return out;\n}\n" },
    command: "sed -i.bak -e 's|const out: string\\[\\] = \\[\\];|const lines: string[] = [];|; s|out.push|lines.push|; s|return out;|return lines;|' src/types.ts && rm -f src/types.ts.bak",
  },
];

const check = (condition, message) => { if (!condition) throw new Error(message); };

function validateCommon(item) {
  check(typeof item.id === "string" && item.id, `case without an id: ${JSON.stringify(item).slice(0, 80)}`);
  check(SPLITS.includes(item.split) && item.split !== "all", `${item.id}: split must be tune or holdout`);
  check(["violation", "clean"].includes(item.label), `${item.id}: label must be violation or clean`);
  check(KINDS.includes(item.kind), `${item.id}: unknown kind ${item.kind}`);
  check(item.label === (item.kind === "violation" ? "violation" : "clean"), `${item.id}: label and kind disagree`);
  check(typeof item.task === "string" && item.task.trim(), `${item.id}: no task`);
  check(typeof item.rule === "string" && item.rule, `${item.id}: no target rule`);
}

export function loadTurnCases() {
  const known = new Set(ruleIds(TURN_RULES_FIXTURE));
  const seen = new Set();
  for (const item of TURN_CASES) {
    validateCommon(item);
    check(!seen.has(item.id), `duplicate case id ${item.id}`);
    seen.add(item.id);
    check(known.has(item.rule), `${item.id}: unknown target rule ${item.rule}`);
    check(typeof item.diff === "string" && item.diff.includes("diff --git"), `${item.id}: no diff`);
    check((item.diff.match(/^diff --git /gm) ?? []).length >= 2, `${item.id}: the diff must touch at least two files`);
  }
  return TURN_CASES;
}

export function loadShellCases() {
  const known = new Set(ruleIds(SHELL_RULES_FIXTURE));
  const seen = new Set();
  for (const item of SHELL_CASES) {
    validateCommon(item);
    check(!seen.has(item.id), `duplicate case id ${item.id}`);
    seen.add(item.id);
    check(known.has(item.rule), `${item.id}: unknown target rule ${item.rule}`);
    check(typeof item.path === "string" && item.path, `${item.id}: no target path`);
    check(item.files && typeof item.files === "object", `${item.id}: no starting files`);
    check(typeof item.command === "string" && item.command.trim(), `${item.id}: no command`);
  }
  return SHELL_CASES;
}

/** The rule ids each fixture defines, so a case's target rule is known to exist. */
export function ruleIds(fixture) {
  const ids = [];
  for (const line of readFileSync(fixture, "utf8").split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) ids.push(heading[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  }
  return ids;
}
