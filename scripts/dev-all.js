import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const isWindows = process.platform === 'win32';

const ngrokCandidates = isWindows
  ? [
      process.env.NGROK_PATH,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ngrok.exe'),
      'ngrok.exe',
    ].filter(Boolean)
  : ['ngrok'];

const resolveExecutable = (candidates) => candidates.find((candidate) => {
  if (!candidate) {
    return false;
  }

  if (path.isAbsolute(candidate)) {
    return existsSync(candidate);
  }

  return true;
});

const ngrokCommand = resolveExecutable(ngrokCandidates);
const ngrokAuthtoken = process.env.NGROK_AUTHTOKEN || process.env.NGROK_AUTHTOKEN_VALUE || '';

const shouldStartNgrok = Boolean(ngrokCommand && ngrokAuthtoken);

const processes = [];

const startProcess = (name, command, args, options = {}) => {
  const useWindowsCmd = isWindows && typeof command === 'string' && command.toLowerCase().endsWith('.cmd');
  const spawnCommand = useWindowsCmd ? 'cmd.exe' : command;
  const spawnArgs = useWindowsCmd ? ['/d', '/s', '/c', command, ...args] : args;

  const child = spawn(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    shell: options.shell ?? false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[dev:all] ${name} terminó por señal ${signal}`);
    } else {
      console.log(`[dev:all] ${name} salió con código ${code ?? 0}`);
    }

    if (name === 'ngrok') {
      if ((code ?? 0) !== 0) {
        console.log('[dev:all] ngrok se detuvo; backend y frontend siguen activos. Revisá NGROK_AUTHTOKEN o la cuenta de ngrok.');
      }
      return;
    }

    shutdown(code ?? 0);
  });

  processes.push(child);
  return child;
};

let shuttingDown = false;

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

console.log('[dev:all] Arrancando frontend, backend y ngrok...');
startProcess('frontend', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev']);
startProcess('backend', isWindows ? 'npm.cmd' : 'npm', ['run', 'dev:api']);

if (shouldStartNgrok) {
  startProcess('ngrok', ngrokCommand, ['http', '3001', '--authtoken', ngrokAuthtoken], { shell: false });
} else {
  console.warn('[dev:all] ngrok no está disponible o falta NGROK_AUTHTOKEN; se continúa sin túnel público.');
}