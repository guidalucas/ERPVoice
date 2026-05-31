import { spawn } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const isWindows = process.platform === 'win32';
const processes = [];
let shuttingDown = false;

const startProcess = (name, command, args) => {
  const useWindowsCmd = isWindows && typeof command === 'string' && command.toLowerCase().endsWith('.cmd');
  const spawnCommand = useWindowsCmd ? 'cmd.exe' : command;
  const spawnArgs = useWindowsCmd ? ['/d', '/s', '/c', command, ...args] : args;

  const child = spawn(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[dev:frontback] ${name} terminó por señal ${signal}`);
    } else {
      console.log(`[dev:frontback] ${name} salió con código ${code ?? 0}`);
    }

    shutdown(code ?? 0);
  });

  processes.push(child);
  return child;
};

const shutdown = (code = 0) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill();
    }
  }

  if (code !== 0) {
    process.exitCode = code;
  }
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev:frontback] Arrancando frontend y backend...');
startProcess('frontend', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev']);
startProcess('backend', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:api']);