import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadEnvFile } from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
// Optional: a private .env can supply TYPESAFE_API_KEY; otherwise the key stored by /typesafe login is used.
try {
  loadEnvFile(join(root, '.env'));
} catch {
  // No .env present.
}
// --no-extensions keeps an installed pi-warden from loading alongside the working tree. pi-typesafe is loaded
// too when installed, so /typesafe login is available for storing a key.
const typesafe = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-typesafe');
const args = ['--no-extensions', '-e', root];
if (existsSync(typesafe)) args.push('-e', typesafe);
const child = spawn('pi', [...args, ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: 'inherit' });
child.on('error', () => {
  console.error('Could not start Pi. Install the Pi CLI and make it available on PATH.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
