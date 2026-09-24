import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { evaluateAction, matchPatterns, sqlTarget } from "../src/guard.js";

const HOSTED = "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

const hitsOf = (command: string) => matchPatterns("bash", { command }).map(hit => [hit.id, hit.severity]);
/** The offline level: no judge, so the pattern floor decides. */
const levelOf = async (command: string) => (await evaluateAction({ tool: "bash", input: { command }, cwd: process.cwd() }, { config: defaultConfig().action })).level;

test("sqlTarget reads loopback, hosted, and unknown targets", () => {
  assert.equal(sqlTarget("psql -h 127.0.0.1 -U postgres -c 'SELECT 1'"), "loopback");
  assert.equal(sqlTarget("PGHOST=localhost psql -c 'SELECT 1'"), "loopback");
  assert.equal(sqlTarget("psql --host=/var/run/postgresql -d app"), "loopback");
  assert.equal(sqlTarget("psql postgres://user:pw@[::1]:5432/app"), "loopback");
  assert.equal(sqlTarget("psql -d 'host=localhost dbname=app'"), "loopback");
  assert.equal(sqlTarget(`psql "${HOSTED}" -c 'SELECT 1'`), "hosted");
  assert.equal(sqlTarget("psql -h db.abc.supabase.co -c 'SELECT 1'"), "hosted");
  assert.equal(sqlTarget("mysql -h main.abc.us-east-1.rds.amazonaws.com -e 'SELECT 1'"), "hosted");
  assert.equal(sqlTarget("supabase db dump --linked"), "hosted");
  assert.equal(sqlTarget("supabase db query --target dev"), "hosted");
  assert.equal(sqlTarget("supabase db query --target local"), "unknown");
  assert.equal(sqlTarget("psql \"$DATABASE_URL\" -c 'SELECT 1'"), "unknown");
  assert.equal(sqlTarget("psql -h $DB_HOST -c 'SELECT 1'"), "unknown");
  assert.equal(sqlTarget("psql -h db.internal -c 'SELECT 1'"), "unknown");
  assert.equal(sqlTarget("psql -c 'SELECT 1'"), "unknown");
  assert.equal(sqlTarget("ls -h localhost"), "unknown");
});

test("a loopback DELETE … WHERE warns", async () => {
  const command = "psql -h 127.0.0.1 -U postgres -d app -c \"DELETE FROM users WHERE email LIKE 'crew-%';\"";
  assert.deepEqual(hitsOf(command), [["sql-delete-local", "risky"]]);
  assert.equal(await levelOf(command), "warn");
});

test("a loopback TRUNCATE holds", async () => {
  const command = "psql -h localhost -c 'TRUNCATE users;'";
  assert.deepEqual(hitsOf(command), [["sql-truncate", "destructive"]]);
  assert.equal(await levelOf(command), "confirm");
});

test("a loopback DELETE FROM users; with no WHERE holds", async () => {
  const command = "psql -h 127.0.0.1 -c 'DELETE FROM users;'";
  assert.deepEqual(hitsOf(command), [["sql-delete", "destructive"]]);
  assert.equal(await levelOf(command), "confirm");
  assert.deepEqual(hitsOf("psql -h 127.0.0.1 -c \"DELETE FROM users; SELECT * FROM users WHERE id = 1\""), [["sql-delete", "destructive"]], "a WHERE in another statement does not scope the DELETE");
  assert.deepEqual(hitsOf("psql -h 127.0.0.1 -c \"DELETE FROM a WHERE id = 1\" && psql -h db.internal -c \"DELETE FROM b WHERE id = 1\""), [["sql-delete", "destructive"]], "every DELETE must target loopback");
});

test("a hosted SELECT warns as elevated", async () => {
  const command = `psql "${HOSTED}" -c 'SELECT count(*) FROM users'`;
  assert.deepEqual(hitsOf(command), [["sql-hosted", "risky"]]);
  assert.match(matchPatterns("bash", { command })[0]!.label, /aws-0-us-east-1\.pooler\.supabase\.com/);
  assert.doesNotMatch(matchPatterns("bash", { command })[0]!.label, /pw@/);
  assert.equal(await levelOf(command), "warn");
});

test("a hosted UPDATE holds", async () => {
  const command = `psql "${HOSTED}" -c "UPDATE users SET plan = 'pro' WHERE id = 7"`;
  assert.deepEqual(hitsOf(command), [["sql-hosted", "risky"], ["sql-hosted-write", "destructive"]]);
  assert.equal(await levelOf(command), "confirm");
  assert.deepEqual(hitsOf(`psql "${HOSTED}" <<'SQL'\nUPDATE users SET plan = 'pro';\nSQL`), [["sql-hosted", "risky"], ["sql-hosted-write", "destructive"]], "a heredoc fed to psql is read");
});

test("a hosted read-only wrapper with a SELECT is quiet", async () => {
  const command = `psql "${HOSTED}" -c "BEGIN READ ONLY; SELECT count(*) FROM users; ROLLBACK;"`;
  assert.deepEqual(hitsOf(command), []);
  assert.equal(await levelOf(command), "allow");
  assert.deepEqual(hitsOf(`psql "${HOSTED}" <<'SQL'\nSTART TRANSACTION READ ONLY;\nSELECT 1;\nROLLBACK;\nSQL`), []);
  assert.deepEqual(hitsOf(`psql "${HOSTED}" -c "BEGIN; SET TRANSACTION READ ONLY; DELETE FROM users WHERE id = 1; ROLLBACK;"`), [], "Postgres rejects the write, so no write hit");
});

test("a read-only wrapper followed by COMMIT is not exempt", async () => {
  const command = `psql "${HOSTED}" -c "BEGIN READ ONLY; SELECT 1; ROLLBACK; COMMIT;"`;
  assert.deepEqual(hitsOf(command), [["sql-hosted", "risky"]]);
  assert.equal(await levelOf(command), "warn");
  assert.deepEqual(hitsOf(`psql "${HOSTED}" -c "BEGIN READ ONLY; SELECT 1; ROLLBACK; DELETE FROM users WHERE id = 1; ROLLBACK;"`), [["sql-delete", "destructive"], ["sql-hosted", "risky"], ["sql-hosted-write", "destructive"]], "a write after an inner ROLLBACK runs outside the transaction");
  assert.deepEqual(hitsOf(`psql -1 "${HOSTED}" -c "BEGIN READ ONLY; SELECT 1; ROLLBACK;"`), [["sql-hosted", "risky"]], "--single-transaction wraps the SQL in its own transaction");
});

test("$DATABASE_URL keeps today's behaviour", async () => {
  assert.deepEqual(hitsOf("psql \"$DATABASE_URL\" -c \"DELETE FROM users WHERE email LIKE 'crew-%'\""), [["sql-delete", "destructive"]]);
  assert.deepEqual(hitsOf("psql \"$DATABASE_URL\" -c 'UPDATE users SET plan = 1'"), []);
  assert.deepEqual(hitsOf("psql \"$DATABASE_URL\" -c 'BEGIN READ ONLY; DROP TABLE users; ROLLBACK;'"), [["sql-drop", "destructive"]]);
  assert.deepEqual(hitsOf("psql -h 127.0.0.1 -f cleanup.sql"), [], "SQL from a file is not read");
});
