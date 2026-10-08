// atmin: one command for every atmin tool. `atmin <tool> [args]` runs the executable
// `atmin-<tool>` found on PATH with the same arguments, the way git and gh run their
// extensions. Each tool installs its own `atmin-*` executables; this command owns none.
import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const executable = name => process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];

// Every `atmin-*` tool on PATH, first match per name, as PATH resolution would pick it.
export function tools(path = process.env.PATH ?? '') {
  const found = new Map();
  for (const directory of path.split(delimiter).filter(Boolean)) {
    let entries;
    try { entries = readdirSync(directory); } catch { continue; }
    for (const entry of entries) {
      const name = entry.replace(/\.(cmd|exe)$/i, '');
      if (!/^atmin-[a-z0-9][a-z0-9-]*$/.test(name) || found.has(name)) continue;
      try { accessSync(join(directory, entry), constants.X_OK); found.set(name, join(directory, entry)); } catch { /* not executable */ }
    }
  }
  return found;
}

function help(found) {
  const names = [...found.keys()].map(name => name.slice('atmin-'.length)).sort();
  return `atmin ${version}\n\n  atmin <command> [arguments]\n\n`
    + (names.length ? `Installed commands:\n${names.map(name => `  ${name}`).join('\n')}\n` : 'No atmin commands are installed.\n')
    + '\nEach command is a separate tool; `atmin review` runs `atmin-review`. Install a tool to add its commands,\n'
    + 'for example `brew install atmin-inc/tap/atmin-review`.\n';
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const found = tools();
  if (!command || command === '--help' || command === '-h' || command === 'help') { process.stdout.write(help(found)); return; }
  if (command === '--version' || command === '-v') { process.stdout.write(`${version}\n`); return; }
  const target = /^[a-z0-9][a-z0-9-]*$/.test(command) ? found.get(`atmin-${command}`) : undefined;
  if (!target) {
    process.stderr.write(`atmin: '${command}' is not an installed atmin command.\n\n${help(found)}`);
    process.exitCode = 1; return;
  }
  // The terminal sends Ctrl-C to both processes; the tool decides what it means (the review
  // runner finishes its review first), so this command waits for it rather than exiting.
  // Handlers go in before the tool starts: a stop signal in between killed this command and
  // left the tool running, holding its output open (a CI run hung on it, 2026-10-08). Node
  // runs them only once main returns, when `child` is set.
  let child;
  const forward = signal => () => { if (signal !== 'SIGINT') child.kill(signal); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward(signal));
  child = spawn(target, rest, { stdio: 'inherit', shell: process.platform === 'win32' && /\.cmd$/i.test(target) });
  child.on('error', error => { process.stderr.write(`atmin: could not run ${target}: ${error.message}\n`); process.exit(1); });
  child.on('exit', (code, signal) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}

