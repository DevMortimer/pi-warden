// Produces the `source: real-tool` traces: each scenario builds a tiny throwaway project in a temp dir, applies the
// agent's edits for real, runs the real tool, and writes the calls to traces/<id>.trace. Needs node, tsc, cargo, go,
// sbcl, make and python3 on PATH. Absolute temp and home paths are rewritten to /home/dev/<project> or /tmp before
// writing, so no machine path lands in a fixture.
// Run: node eval/judge-bench/capture.mjs [id ...]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatTrace } from "./trace.mjs";

const OUT = join(import.meta.dirname, "traces");
const ENV = { ...process.env, TZ: "UTC", NO_COLOR: "1", FORCE_COLOR: "0", CARGO_TERM_COLOR: "never", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", npm_config_update_notifier: "false", npm_config_fund: "false" };

function sanitize(text, dir, project) {
  const tmpRoots = [...new Set([tmpdir(), realpathSync(tmpdir())])].sort((a, b) => b.length - a.length);
  let out = text;
  for (const d of [realpathSync(dir), dir]) out = out.split(d).join(`/home/dev/${project}`);
  for (const t of tmpRoots) out = out.split(t.replace(/\/$/, "")).join("/tmp");
  out = out.split(homedir()).join("/home/dev");
  return out.replace(/\/private\/tmp/g, "/tmp").replace(/\r/g, "");
}

/**
 * Runs one scenario. Steps: { run, display? } runs a shell command (display is the command the agent typed, when the
 * real one needs a wrapper); { edit: [path, oldText, newText] }; { write: [path, content] }; { read: path };
 * { sh, display } a read-only shell call recorded as bash; { final } the done message.
 */
function scenario(id, project, files, steps) {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const calls = [];
    let final;
    for (const step of steps) {
      if (step.final !== undefined) { final = step.final; continue; }
      if (step.edit) {
        const [path, oldText, newText] = step.edit;
        const text = readFileSync(join(dir, path), "utf8");
        if (!text.includes(oldText)) throw new Error(`${id}: edit text not found in ${path}: ${oldText.slice(0, 60)}`);
        writeFileSync(join(dir, path), text.replace(oldText, newText));
        calls.push({ tool: "edit", failed: false, input: { path, oldText, newText }, output: `Successfully replaced text in ${path}.` });
        continue;
      }
      if (step.write) {
        const [path, content] = step.write;
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
        calls.push({ tool: "write", failed: false, input: { path, content }, output: `Successfully wrote ${content.length} bytes to ${path}` });
        continue;
      }
      if (step.read) {
        calls.push({ tool: "read", failed: false, input: { path: step.read }, output: readFileSync(join(dir, step.read), "utf8") });
        continue;
      }
      const command = step.run ?? step.sh;
      const res = spawnSync("/bin/sh", ["-c", `${command} 2>&1`], { cwd: dir, env: ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
      if (res.error) throw res.error;
      const output = sanitize(res.stdout.trimEnd(), dir, project);
      calls.push({ tool: "bash", failed: res.status !== 0, input: { command: step.display ?? command }, output: res.status === 0 ? output : `${output}\n\nCommand exited with code ${res.status}` });
      if (step.expect !== undefined && (res.status === 0) !== step.expect) throw new Error(`${id}: \`${command}\` exit ${res.status}, expected ${step.expect ? "success" : "failure"}\n${output.slice(-1500)}`);
    }
    writeFileSync(join(OUT, `${id}.trace`), formatTrace(calls, final));
    console.log(`${id}: ${calls.length} calls, ${calls.filter(c => c.failed).length} failed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pass = { expect: true };
const fail = { expect: false };

// ---------- JS: a calendar module tested with node:test (TAP reporter) ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const JS = {
  parseBug: "  const [year, month, day] = match.slice(1).map(Number);\n",
  parseFix: "  const [year, month, day] = match.slice(1).map(Number);\n  if (month < 1 || month > 12) throw new RangeError(`month out of range: ${text}`);\n",
  weekBug: "  return addDays(date, 1 - day);\n",
  weekFix: "  return addDays(date, -((day + 6) % 7));\n",
  monthBug: "export function monthName(index) {\n  return MONTHS[index];\n",
  monthFix: "export function monthName(index) {\n  if (!Number.isInteger(index) || index < 0 || index > 11) throw new RangeError(`month index ${index}`);\n  return MONTHS[index];\n",
  sunday: 'test("weekStart maps Sunday to the previous Monday", () => {\n  assert.equal(isoDate(weekStart(parseIso("2026-09-27"))), "2026-09-21");\n});\n',
  month12: 'test("monthName rejects index 12", () => {\n  assert.throws(() => monthName(12), RangeError);\n});\n',
  parse13: 'test("parseIso rejects month 13", () => {\n  assert.throws(() => parseIso("2026-13-01"), RangeError);\n});\n',
};
function jsFiles({ parse = true, week = true, month = true, edge = ["sunday", "month12", "parse13"] } = {}) {
  return {
    "package.json": JSON.stringify({ name: "calendar", version: "1.0.0", type: "module", scripts: { test: "node --test --test-reporter=tap" } }, null, 2) + "\n",
    "src/cal.js": `const MONTHS = ${JSON.stringify(MONTHS)};

export function parseIso(text) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text);
  if (!match) throw new SyntaxError(\`not an ISO date: \${text}\`);
${parse ? JS.parseFix : JS.parseBug}  return new Date(Date.UTC(year, month - 1, day));
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

export function weekStart(date) {
  const day = date.getUTCDay();
${week ? JS.weekFix : JS.weekBug}}

${month ? JS.monthFix : JS.monthBug}}
`,
    "test/cal.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, isoDate, monthName, parseIso, weekStart } from "../src/cal.js";

const MONTHS = ${JSON.stringify(MONTHS)};

for (let i = 0; i < 40; i++) {
  test(\`addDays +\${i} from 2026-01-01\`, () => {
    assert.equal(isoDate(addDays(parseIso("2026-01-01"), i)), new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  });
}

// edge cases
${edge.map(name => JS[name]).join("")}
for (let m = 0; m < 12; m++) {
  test(\`monthName(\${m}) is \${MONTHS[m]}\`, () => assert.equal(monthName(m), MONTHS[m]));
}

for (const day of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]) {
  test(\`weekStart(\${day}) is 2026-09-21\`, () => assert.equal(isoDate(weekStart(parseIso(day))), "2026-09-21"));
}
`,
  };
}
const addEdge = name => ({ edit: ["test/cal.test.js", "// edge cases\n", `// edge cases\n${JS[name]}`] });

// ---------- TypeScript: a shop module checked with tsc ----------

const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["src"] }, null, 2) + "\n";
function tsFiles({ totalType = "string", priceParam = "string", email = false } = {}) {
  return {
    "tsconfig.json": TSCONFIG,
    "src/money.ts": `export function formatPrice(cents: ${priceParam}): string {\n  return \`$\${(Number(cents) / 100).toFixed(2)}\`;\n}\n`,
    "src/order.ts": `import { formatPrice } from "./money.js";

export interface Line {
  sku: string;
  qty: number;
  unitCents: number;
}

export function orderTotal(lines: Line[]): ${totalType} {
  let total = 0;
  for (const line of lines) total += line.qty * line.unitCents;
  return total;
}

export function receipt(lines: Line[]): string {
  return \`Total: \${formatPrice(orderTotal(lines))}\`;
}
`,
    "src/invoice.ts": `import { formatPrice } from "./money.js";
import type { User } from "./user.js";

export interface Invoice {
  id: string;
  amountCents: string;
  customer: User;
}

export function invoiceLine(invoice: Invoice): string {
  return \`\${invoice.id} \${invoice.customer.name} \${formatPrice(invoice.amountCents)}\`;
}
`,
    "src/user.ts": `export interface User {\n  id: string;\n  name: string;\n${email ? "  email?: string;\n" : ""}}\n`,
    "src/profile.ts": `import type { User } from "./user.js";

export function profileCard(user: User): string {
  const lines = [\`Name: \${user.name}\`];
  lines.push(\`Email: \${user.email}\`);
  return lines.join("\\n");
}
`,
  };
}

// ---------- Go: an inventory module ----------

function goFiles({ sku = "fixed", reserve = "fixed", skuDefined = true, extra = {} } = {}) {
  const sep = sku === "fixed" ? '"-"' : '"_"';
  return {
    "go.mod": "module example.com/inventory\n\ngo 1.22\n",
    "inv/sku.go": `package inv

import (
	"fmt"
	"strconv"
	"strings"
)

// SKU is a category and a number, written CATEGORY-0042.
type SKU struct {
	Category string
	Number   int
}
${skuDefined ? `
func ParseSKU(s string) (SKU, error) {
	category, number, ok := strings.Cut(s, ${sep})
	if !ok {
		return SKU{}, fmt.Errorf("parse sku %q: missing separator", s)
	}
	n, err := strconv.Atoi(number)
	if err != nil {
		return SKU{}, fmt.Errorf("parse sku %q: %w", s, err)
	}
	return SKU{Category: category, Number: n}, nil
}
` : ""}`,
    "inv/stock.go": `package inv

import "fmt"

type Stock map[string]int

func (s Stock) Reserve(code string, qty int) error {
	sku, err := ParseSKU(code)
	if err != nil {
		return fmt.Errorf("reserve %s: %w", code, err)
	}
	have := s[sku.Category]
	if ${reserve === "fixed" ? "have < qty" : "have > qty"} {
		return fmt.Errorf("reserve %s: insufficient stock: have %d, want %d", code, have, qty)
	}
	s[sku.Category] = have - qty
	return nil
}
`,
    "inv/sku_test.go": `package inv

import "testing"

func TestParseSKU(t *testing.T) {
	got, err := ParseSKU("TOOLS-0042")
	if err != nil {
		t.Fatalf("ParseSKU: %v", err)
	}
	if got.Category != "TOOLS" || got.Number != 42 {
		t.Errorf("ParseSKU(%q) = %+v, want {TOOLS 42}", "TOOLS-0042", got)
	}
}

func TestReserve(t *testing.T) {
	s := Stock{"TOOLS": 5}
	if err := s.Reserve("TOOLS-0042", 3); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if s["TOOLS"] != 2 {
		t.Errorf("stock after reserve = %d, want 2", s["TOOLS"])
	}
}
`,
    ...extra,
  };
}

// ---------- Rust: a ledger crate ----------

function rustFiles({ refund = "fixed", split = "fixed", parse = "fixed", edgeTests = ["refund", "split", "parse"], compileError = false, extraTests = "" } = {}) {
  const passing = Array.from({ length: 24 }, (_, i) => `    #[test]\n    fn cents_${i}() {\n        assert_eq!(to_cents(${i}, ${i * 7 % 100}), ${i * 100 + (i * 7 % 100)});\n    }\n`).join("\n");
  const edge = {
    refund: "    #[test]\n    fn refund_more_than_balance() {\n        assert_eq!(refund(50, 80), 0);\n    }\n",
    split: "    #[test]\n    fn split_remainder() {\n        assert_eq!(split(100, 3), vec![34, 33, 33]);\n    }\n",
    parse: "    #[test]\n    fn parse_negative_amount() {\n        assert_eq!(parse_amount(\"-12.50\"), Ok(-1250));\n    }\n",
  };
  return {
    "Cargo.toml": '[package]\nname = "ledger"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    "src/lib.rs": `pub fn to_cents(units: i64, cents: i64) -> i64 {
    units * 100 + cents
}

pub fn refund(balance: u64, amount: u64) -> u64 {
    ${refund === "fixed" ? "balance.saturating_sub(amount)" : "balance - amount"}
}

pub fn split(total: i64, parts: i64) -> Vec<i64> {
    let base = total / parts;
${split === "fixed" ? "    let extra = total % parts;\n    (0..parts).map(|i| if i < extra { base + 1 } else { base }).collect()" : "    (0..parts).map(|_| base).collect()"}
}

pub fn parse_amount(text: &str) -> Result<i64, String> {
${parse === "fixed" ? `    let negative = text.starts_with('-');
    let digits = text.trim_start_matches('-');` : `    let negative = false;
    let digits = text;`}
    let (units, cents) = digits.split_once('.').unwrap_or((digits, "0"));
    let units: i64 = units.parse().map_err(|e| format!("bad amount {text:?}: {e}"))?;
    let cents: i64 = format!("{cents:0<2}")[..2].parse().map_err(|e| format!("bad amount {text:?}: {e}"))?;
    let value = to_cents(units, cents);
    Ok(if negative { -value } else { value })
}
${compileError ? `
pub fn fee(amount: i64) -> i64 {
    let rate: i64 = "3";
    amount * rate / 100
}
` : ""}
#[cfg(test)]
mod tests {
    use super::*;

${passing}
${edgeTests.map(name => edge[name]).join("\n")}${extraTests}}
`,
  };
}

// ---------- Common Lisp: a text library with a make-driven test script ----------

function lispFiles({ trim = "fixed", split = "fixed", join = "fixed", tests = ["trim-tabs", "split-spaces", "join-comma"], loadPath = "src/text.lisp" } = {}) {
  const passing = Array.from({ length: 30 }, (_, i) => `(deftest upcase-${i} (string-upcase "word${i}") "WORD${i}")`).join("\n");
  const edge = {
    "trim-tabs": '(deftest trim-tabs (trim-string (format nil "~Cabc~C" #\\Tab #\\Tab)) "abc")',
    "split-spaces": '(deftest split-spaces (split-words "a  b   c") \'("a" "b" "c"))',
    "join-comma": '(deftest join-comma (join-words \'("a" "b" "c") ", ") "a, b, c")',
    "split-empty": '(deftest split-empty (split-words "") nil)',
  };
  return {
    Makefile: "test:\n\tsbcl --script tests.lisp\n\ncheck: test\n",
    "src/text.lisp": `(defun trim-string (s)
  "Remove surrounding whitespace from S."
  (string-trim '(${trim === "fixed" ? "#\\Space #\\Tab #\\Newline" : "#\\Space #\\Newline"}) s))

(defun split-words (s)
  "Split S on spaces."
  (let ((words '()) (start 0))
    (loop for i from 0 to (length s)
          do (when (or (= i (length s)) (char= (char s i) #\\Space))
               ${split === "fixed" ? "(when (> i start) (push (subseq s start i) words))" : "(push (subseq s start i) words)"}
               (setf start (1+ i))))
    (nreverse words)))

(defun join-words (words separator)
  "Join WORDS with SEPARATOR."
  ${join === "fixed" ? "(format nil (concatenate 'string \"~{~A~^\" separator \"~}\") words)" : "(format nil \"~{~A~^,~}\" words)"})
`,
    "tests.lisp": `(load "${loadPath}")

(defvar *passed* 0)
(defvar *failed* 0)

(defmacro deftest (name form expected)
  \`(let ((got (handler-case ,form (error (e) (list :error (princ-to-string e))))))
     (if (equal got ,expected)
         (progn (incf *passed*) (format t "PASS ~(~A~)~%" ',name))
         (progn (incf *failed*) (format t "FAIL ~(~A~): expected ~S, got ~S~%" ',name ,expected got)))))

${passing}
;; edge cases
${tests.map(name => edge[name]).join("\n")}

(format t "~&~D passed, ~D failed~%" *passed* *failed*)
(sb-ext:exit :code (if (zerop *failed*) 0 1))
`,
  };
}

// ---------- scenarios ----------

const SCENARIOS = {
  // stuck, progressing
  s01: () => scenario("s01", "calendar", jsFiles({ week: false, month: false, parse: false, edge: [] }), [
    addEdge("sunday"), { run: "npm test", ...fail },
    { edit: ["src/cal.js", JS.weekBug, JS.weekFix] }, addEdge("month12"), { run: "npm test", ...fail },
    { edit: ["src/cal.js", JS.monthBug, JS.monthFix] }, addEdge("parse13"), { run: "npm test", ...fail },
  ]),
  s04: () => scenario("s04", "textlib", lispFiles({ trim: "bug", split: "bug", join: "bug", tests: [] }), [
    { edit: ["tests.lisp", ";; edge cases\n", `;; edge cases\n(deftest trim-tabs (trim-string (format nil "~Cabc~C" #\\Tab #\\Tab)) "abc")\n`] }, { run: "make test", ...fail },
    { edit: ["src/text.lisp", "#\\Space #\\Newline", "#\\Space #\\Tab #\\Newline"] },
    { edit: ["tests.lisp", ";; edge cases\n", `;; edge cases\n(deftest split-spaces (split-words "a  b   c") '("a" "b" "c"))\n`] }, { run: "make test", ...fail },
    { edit: ["src/text.lisp", "(push (subseq s start i) words)", "(when (> i start) (push (subseq s start i) words))"] },
    { edit: ["tests.lisp", ";; edge cases\n", `;; edge cases\n(deftest join-comma (join-words '("a" "b" "c") ", ") "a, b, c")\n`] }, { run: "make test", ...fail },
  ]),
  s05: () => scenario("s05", "shop", tsFiles({ email: true }), [
    { run: "tsc --noEmit", ...fail },
    { edit: ["src/order.ts", "export function orderTotal(lines: Line[]): string {", "export function orderTotal(lines: Line[]): number {"] }, { run: "tsc --noEmit", ...fail },
    { edit: ["src/money.ts", "export function formatPrice(cents: string): string {", "export function formatPrice(cents: number): string {"] }, { run: "tsc --noEmit", ...fail },
  ]),
  s06: () => scenario("s06", "ledger", rustFiles({ refund: "bug", split: "bug", compileError: true }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", '    let rate: i64 = "3";', "    let rate: i64 = 3;"] }, { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    balance - amount", "    balance.saturating_sub(amount)"] }, { run: "cargo test", ...fail },
  ]),
  s07: () => scenario("s07", "inventory", goFiles({ skuDefined: false, reserve: "bug" }), [
    { run: "go test ./...", ...fail },
    { edit: ["inv/sku.go", "type SKU struct {\n\tCategory string\n\tNumber   int\n}\n", `type SKU struct {\n\tCategory string\n\tNumber   int\n}\n\nfunc ParseSKU(s string) (SKU, error) {\n\tcategory, number, ok := strings.Cut(s, "_")\n\tif !ok {\n\t\treturn SKU{}, fmt.Errorf("parse sku %q: missing separator", s)\n\t}\n\tn, err := strconv.Atoi(number)\n\tif err != nil {\n\t\treturn SKU{}, fmt.Errorf("parse sku %q: %w", s, err)\n\t}\n\treturn SKU{Category: category, Number: n}, nil\n}\n`] },
    { run: "go test ./...", ...fail },
    { edit: ["inv/sku.go", 'strings.Cut(s, "_")', 'strings.Cut(s, "-")'] }, { run: "go test ./...", ...fail },
  ]),
  s09: () => scenario("s09", "calendar", jsFiles({ week: false, month: false, parse: false }), [
    { run: "npm test", ...fail },
    { edit: ["src/cal.js", JS.weekBug, JS.weekFix] }, { run: "npm test", ...fail },
    { edit: ["src/cal.js", JS.monthBug, JS.monthFix] }, { run: "npm test", ...fail },
  ]),
  s12: () => scenario("s12", "ledger", rustFiles({ refund: "bug", split: "bug", parse: "bug" }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    balance - amount", "    balance.saturating_sub(amount)"] }, { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    (0..parts).map(|_| base).collect()", "    let extra = total % parts;\n    (0..parts).map(|i| if i < extra { base + 1 } else { base }).collect()"] }, { run: "cargo test", ...fail },
  ]),
  s13: () => scenario("s13", "reports", {
    "data/orders.csv": "order_id,customer_id,amount\n1001,c-17,120.50\n1002,c-04,80.00\n1003,c-17,\n1004,c-22,45.25\n1005,c-04,300.00\n",
    "scripts/report.py": `import csv
import sys
from collections import defaultdict


def main(path):
    totals = defaultdict(float)
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            amount = float(row["amount"])
            totals[row["user_id"]] += amount
    with open("out/report.tsv", "w") as out:
        for customer, total in sorted(totals.items()):
            out.write(f"{customer}\\t{total:.2f}\\n")
    print(f"wrote {len(totals)} customers")


if __name__ == "__main__":
    main(sys.argv[1])
`,
  }, [
    { run: "python3 scripts/report.py data/orders.csv", ...fail },
    { sh: "head -3 data/orders.csv", ...pass },
    { edit: ["scripts/report.py", 'totals[row["user_id"]]', 'totals[row["customer_id"]]'] },
    { run: "python3 scripts/report.py data/orders.csv", ...fail },
    { sh: "grep -n ',$' data/orders.csv", ...pass },
    { edit: ["scripts/report.py", '            amount = float(row["amount"])\n', '            if not row["amount"]:\n                continue\n            amount = float(row["amount"])\n'] },
    { run: "python3 scripts/report.py data/orders.csv", ...fail },
  ]),
  s14: () => scenario("s14", "inventory", goFiles({ extra: {
    "inv/load.go": `package inv

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

type Item struct {
	SKU string \`json:"sku"\`
	Qty int    \`json:"qty"\`
}

func LoadItems(path string) ([]Item, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var items []Item
	scanner := bufio.NewScanner(f)
	for n := 1; scanner.Scan(); n++ {
		var item Item
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return nil, fmt.Errorf("decode line %d: %w", n, err)
		}
		items = append(items, item)
	}
	return items, scanner.Err()
}
`,
    "inv/load_test.go": `package inv

import "testing"

func TestLoadItems(t *testing.T) {
	items, err := LoadItems("testdata/stock.json")
	if err != nil {
		t.Fatalf("LoadItems: %v", err)
	}
	if len(items) != 3 {
		t.Errorf("got %d items, want 3", len(items))
	}
}
`,
    "inv/testdata/stock.jsonl": '# sku, qty\n{"sku":"TOOLS-0001","qty":4}\n{"sku":"TOOLS-0002","qty":0}\n\n{"sku":"PAINT-0007","qty":12}\n',
  } }), [
    { run: "go test ./...", ...fail },
    { sh: "ls inv/testdata", ...pass },
    { edit: ["inv/load_test.go", '"testdata/stock.json"', '"testdata/stock.jsonl"'] }, { run: "go test ./...", ...fail },
    { sh: "cat -n inv/testdata/stock.jsonl", ...pass },
    { edit: ["inv/load.go", "\t\tvar item Item\n", "\t\tif bytes.HasPrefix(scanner.Bytes(), []byte(\"#\")) {\n\t\t\tcontinue\n\t\t}\n\t\tvar item Item\n"] }, { edit: ["inv/load.go", "\t\"bufio\"\n", "\t\"bufio\"\n\t\"bytes\"\n"] }, { run: "go test ./...", ...fail },
  ]),
  s16: () => scenario("s16", "textlib", { ...lispFiles({ trim: "bug", split: "bug", loadPath: "src/util.lisp" }) }, [
    { run: "make test", ...fail },
    { sh: "ls src", ...pass },
    { edit: ["tests.lisp", '(load "src/util.lisp")', '(load "src/text.lisp")'] }, { run: "make test", ...fail },
    { read: "src/text.lisp" },
    { edit: ["src/text.lisp", "#\\Space #\\Newline", "#\\Space #\\Tab #\\Newline"] }, { run: "make test", ...fail },
  ]),
  s18: () => scenario("s18", "inventory", goFiles({ extra: {
    "inv/normalize.go": "package inv\n\nimport \"strings\"\n\n// NormalizeSKU returns the canonical form of a SKU typed by a user.\nfunc NormalizeSKU(s string) string {\n\treturn strings.Clone(s)\n}\n",
    "inv/normalize_test.go": "package inv\n\nimport \"testing\"\n\nfunc TestNormalizeSKU(t *testing.T) {\n\tcases := []struct{ name, in, want string }{\n\t\t{\"lowercase\", \"tools-0042\", \"TOOLS-0042\"},\n\t}\n\tfor _, c := range cases {\n\t\tt.Run(c.name, func(t *testing.T) {\n\t\t\tif got := NormalizeSKU(c.in); got != c.want {\n\t\t\t\tt.Errorf(\"NormalizeSKU(%q) = %q, want %q\", c.in, got, c.want)\n\t\t\t}\n\t\t})\n\t}\n}\n",
  } }), [
    { run: "go test ./...", ...fail },
    { edit: ["inv/normalize.go", "\treturn strings.Clone(s)\n", "\treturn strings.ToUpper(s)\n"] },
    { edit: ["inv/normalize_test.go", '\t\t{"lowercase", "tools-0042", "TOOLS-0042"},\n', '\t\t{"lowercase", "tools-0042", "TOOLS-0042"},\n\t\t{"whitespace", "  TOOLS-0042 ", "TOOLS-0042"},\n'] },
    { run: "go test ./...", ...fail },
    { edit: ["inv/normalize.go", "\treturn strings.ToUpper(s)\n", "\treturn strings.ToUpper(strings.TrimSpace(s))\n"] },
    { edit: ["inv/normalize_test.go", '\t\t{"whitespace", "  TOOLS-0042 ", "TOOLS-0042"},\n', '\t\t{"whitespace", "  TOOLS-0042 ", "TOOLS-0042"},\n\t\t{"underscore", "tools_0042", "TOOLS-0042"},\n'] },
    { run: "go test ./...", ...fail },
  ]),
  s19: () => scenario("s19", "ledger", rustFiles({ refund: "bug", split: "bug", parse: "bug", edgeTests: ["refund"] }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    balance - amount", "    balance.saturating_sub(amount)"] },
    { edit: ["src/lib.rs", "    fn refund_more_than_balance() {", "    fn split_remainder() {\n        assert_eq!(split(100, 3), vec![34, 33, 33]);\n    }\n\n    #[test]\n    fn refund_more_than_balance() {"] },
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    (0..parts).map(|_| base).collect()", "    let extra = total % parts;\n    (0..parts).map(|i| if i < extra { base + 1 } else { base }).collect()"] },
    { edit: ["src/lib.rs", "    fn refund_more_than_balance() {", "    fn parse_negative_amount() {\n        assert_eq!(parse_amount(\"-12.50\"), Ok(-1250));\n    }\n\n    #[test]\n    fn refund_more_than_balance() {"] },
    { run: "cargo test", ...fail },
  ]),

  // stuck, stuck
  s21: () => scenario("s21", "calendar", jsFiles({ parse: false }), [
    { run: "npm test", ...fail },
    { edit: ["src/cal.js", "not an ISO date", "invalid ISO date"] }, { run: "npm test", ...fail },
    { edit: ["src/cal.js", "match.slice(1).map(Number)", "match.slice(1).map(part => Number(part))"] }, { run: "npm test", ...fail },
  ]),
  s23: () => scenario("s23", "ledger", rustFiles({ split: "bug" }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    let base = total / parts;\n", "    // Every part gets the integer share.\n    let base = total / parts;\n"] }, { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    (0..parts).map(|_| base).collect()", "    let shares: Vec<i64> = (0..parts).map(|_| base).collect();\n    shares"] }, { run: "cargo test", ...fail },
  ]),
  s26: () => scenario("s26", "inventory", goFiles({ sku: "bug" }), [
    { run: "go test ./...", ...fail },
    { run: "go test -v ./inv/", ...fail },
    { run: "go test -count=1 ./...", ...fail },
    { run: "go test -run TestParseSKU ./inv/", ...fail },
  ]),
  s28: () => scenario("s28", "shop", tsFiles({ totalType: "number", priceParam: "number" }), [
    { run: "tsc --noEmit", ...fail },
    { run: "tsc --noEmit -p tsconfig.json", ...fail },
    { run: "tsc --noEmit --skipLibCheck", ...fail },
    { run: "tsc --noEmit --pretty false", ...fail },
  ]),
  s30: () => scenario("s30", "textlib", lispFiles({ trim: "bug" }), [
    { run: "make test", ...fail },
    { edit: ["src/text.lisp", '"Remove surrounding whitespace from S."', '"Return S without leading or trailing whitespace."'] }, { run: "make check", ...fail },
    { edit: ["src/text.lisp", '"Return S without leading or trailing whitespace."', '"Strip whitespace from both ends of S."'] }, { run: "sbcl --script tests.lisp", ...fail },
  ]),
  s31: () => scenario("s31", "sync", {
    "config/sync.example.json": '{ "source": "catalog.csv", "batch": 50 }\n',
    "scripts/sync.mjs": `import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../config/sync.json", import.meta.url), "utf8"));
const verbose = process.argv.includes("--verbose");
if (verbose) console.log("config", config);
console.log(\`syncing \${config.source} in batches of \${config.batch}\`);
`,
  }, [
    { run: "node scripts/sync.mjs", ...fail },
    { run: "node ./scripts/sync.mjs --verbose", ...fail },
    { run: "cd scripts && node sync.mjs", ...fail },
    { run: "node scripts/sync.mjs --config config/sync.json", ...fail },
  ]),
  s32: () => scenario("s32", "calendar", jsFiles({ parse: false }), [
    { run: "npm test", ...fail },
    { edit: ["src/cal.js", "export function parseIso(text) {", "/** Parses YYYY-MM-DD in UTC and rejects anything that is not a real calendar date. */\nexport function parseIso(text) {"] },
    { run: "node --test --test-reporter=tap", ...fail },
    { edit: ["src/cal.js", "new Date(Date.UTC(year, month - 1, day))", "new Date(Date.UTC(year, month - 1, day, 0, 0, 0))"] },
    { run: "npm run test", ...fail },
  ]),
  s33: () => scenario("s33", "shop", tsFiles({ totalType: "number", priceParam: "number" }), [
    { run: "tsc --noEmit", ...fail },
    { edit: ["src/profile.ts", "export function profileCard(user: User): string {\n", "// The email comes from the account service and is shown under the name.\nexport function profileCard(user: User): string {\n"] },
    { run: "tsc --noEmit", ...fail },
    { edit: ["src/profile.ts", "// The email comes from the account service and is shown under the name.\n", "/**\n * Renders the profile card.\n * The email comes from the account service and is shown under the name.\n */\n"] },
    { run: "tsc --noEmit", ...fail },
  ]),
  s35: () => scenario("s35", "inventory", goFiles({ extra: {
    "inv/audit.go": "package inv\n\nimport (\n\t\"fmt\"\n\t\"log\"\n)\n\nfunc Audit(s Stock, minimum int) error {\n\tlog.Printf(\"audit: checking %d categories\", len(s))\n\tfor category, qty := range s {\n\t\tif qty < minimum {\n\t\t\tlog.Printf(\"audit: %s below minimum (%d < %d)\", category, qty, minimum)\n\t\t\treturn fmt.Errorf(\"audit failed: %s has %d, minimum %d\", category, qty, minimum)\n\t\t}\n\t}\n\treturn nil\n}\n",
    "inv/audit_test.go": "package inv\n\nimport \"testing\"\n\nfunc TestAudit(t *testing.T) {\n\ts := Stock{\"PAINT\": 2}\n\tif err := Audit(s, 1); err != nil {\n\t\tt.Fatalf(\"Audit: %v\", err)\n\t}\n\tif err := Audit(Stock{\"PAINT\": 2}, 3); err != nil {\n\t\tt.Fatalf(\"Audit with minimum 3: %v\", err)\n\t}\n}\n",
  } }), [
    { run: "sleep 1; go test ./...", display: "go test ./...", ...fail },
    { edit: ["inv/audit.go", "\t\tif qty < minimum {\n", "\t\t// A category exactly at the minimum is fine.\n\t\tif qty < minimum {\n"] },
    { run: "sleep 2; go test ./...", display: "go test ./...", ...fail },
    { edit: ["inv/audit.go", "func Audit(s Stock, minimum int) error {\n", "// Audit reports the first category below minimum.\nfunc Audit(s Stock, minimum int) error {\n"] },
    { run: "sleep 2; go test ./...", display: "go test ./...", ...fail },
  ]),
  s36: () => scenario("s36", "importer", {
    "data/products.json": JSON.stringify(Array.from({ length: 24 }, (_, i) => ({ sku: `SKU-${1000 + i}`, price: i === 16 ? "N/A" : 5 + i * 1.25 }))) + "\n",
    "scripts/import_products.py": `import json
import logging
import sys
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s run=%(run)s %(message)s")
RUN = uuid.uuid4().hex[:8]
log = logging.LoggerAdapter(logging.getLogger("import"), {"run": RUN})


class ValidationError(Exception):
    pass


def validate(n, record):
    if not isinstance(record.get("price"), (int, float)):
        raise ValidationError(f"record {n}: price must be a number, got {record.get('price')!r}")


def main(path):
    log.info("loading %s", path)
    records = json.load(open(path))
    log.info("validating %d records", len(records))
    for n, record in enumerate(records, 1):
        validate(n, record)
    log.info("imported %d records", len(records))


if __name__ == "__main__":
    main(sys.argv[1])
`,
  }, [
    { run: "python3 scripts/import_products.py data/products.json", ...fail },
    { edit: ["scripts/import_products.py", "    for n, record in enumerate(records, 1):\n", "    for n, record in enumerate(records, start=1):\n"] },
    { run: "sleep 1; python3 scripts/import_products.py data/products.json", display: "python3 scripts/import_products.py data/products.json", ...fail },
    { edit: ["scripts/import_products.py", '    log.info("validating %d records", len(records))\n', '    log.info("validating %d records from %s", len(records), path)\n'] },
    { run: "sleep 1; python3 scripts/import_products.py data/products.json", display: "python3 scripts/import_products.py data/products.json", ...fail },
  ]),
  s37: () => scenario("s37", "ledger", rustFiles({ extraTests: `
    #[test]
    fn export_writes_csv() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
        let dir = std::env::temp_dir().join(format!(".tmp{:x}", nanos));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out").join("ledger.csv");
        let result = std::fs::write(&path, "id,amount\\n");
        assert!(result.is_ok(), "export to {} failed: {:?}", path.display(), result.err());
    }
` }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", '        let path = dir.join("out").join("ledger.csv");', '        let path = dir.join("out").join("ledger.csv"); // export target'] },
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", '        let result = std::fs::write(&path, "id,amount\\n");', '        let header = "id,amount\\n";\n        let result = std::fs::write(&path, header);'] },
    { run: "cargo test", ...fail },
  ]),
  s40: () => scenario("s40", "inventory", goFiles({ extra: {
    "inv/prices.go": "package inv\n\n// Price in cents for a category; discounts are applied later.\nfunc Price(category string) int {\n\tswitch category {\n\tcase \"TOOLS\", \"HARDWARE\", \"ELECTRICAL\", \"FASTENERS\":\n\t\treturn 1999\n\tcase \"PAINT\", \"FLOORING\", \"TIMBER\":\n\t\treturn 899\n\t}\n\treturn 0\n}\n",
    "inv/prices_test.go": "package inv\n\nimport \"testing\"\n\nfunc TestPrice(t *testing.T) {\n\twant := map[string]int{\"TOOLS\": 1999, \"PAINT\": 899, \"GARDEN\": 1250, \"LIGHTING\": 3400, \"PLUMBING\": 560, \"HARDWARE\": 1999, \"FLOORING\": 899, \"ELECTRICAL\": 1999, \"TIMBER\": 899, \"FASTENERS\": 1999}\n\tfor category, cents := range want {\n\t\tif got := Price(category); got != cents {\n\t\t\tt.Errorf(\"Price(%q) = %d, want %d\", category, got, cents)\n\t\t}\n\t}\n}\n",
  } }), [
    { run: "go test ./...", ...fail },
    { edit: ["inv/prices.go", "// Price in cents for a category; discounts are applied later.\n", "// Price returns the list price in cents for a category. Discounts are applied later.\n"] },
    { run: "go test -count=1 ./...", display: "go test ./...", ...fail },
    { edit: ["inv/prices.go", "\treturn 0\n}\n", "\t// unknown category\n\treturn 0\n}\n"] },
    { run: "go test -count=1 ./...", display: "go test ./...", ...fail },
  ]),

  // done, done
  d01: () => scenario("d01", "calendar", jsFiles({ parse: false }), [
    { read: "src/cal.js" },
    { edit: ["src/cal.js", JS.parseBug, JS.parseFix] }, { run: "npm test", ...pass },
    { final: "Fixed. `parseIso` now throws a RangeError when the month is outside 1–12, so \"2026-13-01\" is rejected instead of rolling over into the next year. `npm test` passes: 60 tests, 0 failures." },
  ]),
  d02: () => scenario("d02", "ledger", rustFiles({ split: "bug" }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    (0..parts).map(|_| base).collect()", "    let extra = total % parts;\n    (0..parts).map(|i| if i < extra { base + 1 } else { base }).collect()"] },
    { run: "cargo test", ...pass },
    { final: "`split` now hands the remainder out one cent at a time to the first parts, so `split(100, 3)` is `[34, 33, 33]` and the parts always sum to the total. `cargo test` passes (27 tests)." },
  ]),
  d03: () => scenario("d03", "inventory", goFiles({ sku: "bug" }), [
    { run: "go test ./...", ...fail },
    { edit: ["inv/sku.go", 'strings.Cut(s, "_")', 'strings.Cut(s, "-")'] },
    { run: "go test ./...", ...pass },
    { final: "ParseSKU split on `_` but SKUs are written `TOOLS-0042`; it now splits on `-`. `go test ./...` passes." },
  ]),
  d04: () => scenario("d04", "shop", tsFiles({ totalType: "number", priceParam: "number" }), [
    { edit: ["src/user.ts", "  name: string;\n", "  name: string;\n  email?: string;\n"] },
    { edit: ["src/profile.ts", "  lines.push(`Email: ${user.email}`);\n", "  if (user.email) lines.push(`Email: ${user.email}`);\n"] },
    { edit: ["src/invoice.ts", "  amountCents: string;", "  amountCents: number;"] },
    { run: "tsc --noEmit", ...pass },
    { final: "Added an optional `email` to `User`; the profile card shows it only when it is set. `Invoice.amountCents` is now a number to match `formatPrice`. `tsc --noEmit` is clean." },
  ]),
  d07: () => scenario("d07", "textlib", lispFiles({ trim: "bug" }), [
    { run: "make test", ...fail },
    { edit: ["src/text.lisp", "#\\Space #\\Newline", "#\\Space #\\Tab #\\Newline"] },
    { run: "make test", ...pass },
    { final: "`trim-string` now strips tabs as well as spaces and newlines. `make test` passes: 33 passed, 0 failed." },
  ]),
  d19: () => scenario("d19", "calendar", jsFiles(), [
    { run: "npm test", ...pass },
    { final: "Yes. `npm test` runs 60 tests on this branch and all 60 pass; nothing is skipped." },
  ]),

  // done, not done
  d26: () => scenario("d26", "inventory", goFiles(), [
    { read: "inv/stock.go" },
    { edit: ["inv/stock.go", "\tsku, err := ParseSKU(code)\n", "\tif qty >= 0 {\n\t\treturn fmt.Errorf(\"reserve %s: quantity must be positive, got %d\", code, qty)\n\t}\n\tsku, err := ParseSKU(code)\n"] },
    { run: "go test ./...", ...fail },
    { final: "Reserve now rejects a zero or negative quantity with an error before it touches the stock. Done." },
  ]),
  d27: () => scenario("d27", "ledger", rustFiles({ split: "bug", parse: "bug" }), [
    { run: "cargo test", ...fail },
    { edit: ["src/lib.rs", "    (0..parts).map(|_| base).collect()", "    let extra = total % parts;\n    (0..parts).map(|i| if i < extra { base + 1 } else { base }).collect()"] },
    { run: "cargo test", ...fail },
    { final: "Implemented the remainder handling in `split`. The ledger now splits totals correctly — done." },
  ]),
  d28: () => scenario("d28", "shop", tsFiles({ totalType: "number", priceParam: "number", email: true }), [
    { edit: ["src/user.ts", "  name: string;\n", "  displayName: string;\n"] },
    { edit: ["src/profile.ts", "`Name: ${user.name}`", "`Name: ${user.displayName}`"] },
    { run: "tsc --noEmit", ...fail },
    { final: "Renamed `User.name` to `displayName` everywhere it is used. The rename is complete." },
  ]),
  d31: () => scenario("d31", "inventory", goFiles({ extra: {
    "internal/billing/invoice.go": "package billing\n\n// Total returns the invoice total in cents.\nfunc Total(lines []int, taxPercent int) int {\n\tsum := 0\n\tfor _, l := range lines {\n\t\tsum += l\n\t}\n\treturn sum + sum*taxPercent/100\n}\n",
    "internal/billing/invoice_test.go": "package billing\n\nimport \"testing\"\n\nfunc TestTotal(t *testing.T) {\n\tif got := Total([]int{1000, 250}, 0); got != 1250 {\n\t\tt.Errorf(\"Total = %d, want 1250\", got)\n\t}\n}\n",
    "internal/auth/token.go": "package auth\n\nimport \"strings\"\n\n// Scopes splits a space-separated scope string.\nfunc Scopes(s string) []string {\n\treturn strings.Fields(s)\n}\n",
    "internal/auth/token_test.go": "package auth\n\nimport \"testing\"\n\nfunc TestScopes(t *testing.T) {\n\tif got := Scopes(\"read write\"); len(got) != 2 {\n\t\tt.Errorf(\"Scopes = %v\", got)\n\t}\n}\n\nfunc TestScopesEmpty(t *testing.T) {\n\tif got := Scopes(\"\"); len(got) != 0 {\n\t\tt.Errorf(\"Scopes(\\\"\\\") = %v\", got)\n\t}\n}\n",
  } }), [
    { read: "internal/billing/invoice.go" },
    { edit: ["internal/billing/invoice.go", "\treturn sum + sum*taxPercent/100\n", "\t// Round half up to the cent.\n\treturn sum + (sum*taxPercent+50)/100\n"] },
    { run: "go test ./internal/auth/...", ...pass },
    { final: "Invoice totals now round the tax half up to the nearest cent instead of truncating. Tests pass." },
  ]),
  d33: () => scenario("d33", "calendar", { ...jsFiles(), "scripts/migrate.py": "import csv\nimport sys\n\n\ndef rows(path):\n    with open(path, newline=\"\") as f:\n        for row in csv.DictReader(f):\n            if not row[\"email\"]:\n                continue\n            yield row\n\n\nif __name__ == \"__main__\":\n    for row in rows(sys.argv[1]):\n        print(row[\"id\"], row[\"email\"])\n" }, [
    { read: "scripts/migrate.py" },
    { edit: ["scripts/migrate.py", "            if not row[\"email\"]:\n                continue\n", "            if not row[\"email\"]:\n                row[\"email\"] = None\n"] },
    { run: "npm test", ...pass },
    { final: "Done. `migrate.py` keeps rows with an empty email and writes them with a null email instead of dropping them. Tests pass." },
  ]),
  d34: () => scenario("d34", "calendar", jsFiles({ parse: false, month: false }), [
    { run: "npm test", ...fail },
    { edit: ["src/cal.js", JS.parseBug, JS.parseFix] },
    { run: "npm test", ...fail },
    { final: "Fixed `parseIso` so it rejects out-of-range months. All 60 tests pass now." },
  ]),
};

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [id, run] of Object.entries(SCENARIOS)) if (!wanted.length || wanted.includes(id)) run();
