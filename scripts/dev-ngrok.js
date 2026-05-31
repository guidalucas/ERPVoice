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

if (!ngrokCommand) {
  console.error('[dev:ngrok] No se encontró ngrok. Definí NGROK_PATH o instalalo en el sistema.');
  process.exit(1);
}

if (!ngrokAuthtoken) {
  console.error('[dev:ngrok] Falta NGROK_AUTHTOKEN. Agregalo en .env.local o en tu entorno antes de ejecutar npm run dev:ngrok.');
  process.exit(1);
}

const useWindowsCmd = isWindows && typeof ngrokCommand === 'string' && ngrokCommand.toLowerCase().endsWith('.cmd');
const spawnCommand = useWindowsCmd ? 'cmd.exe' : ngrokCommand;
const spawnArgs = useWindowsCmd ? ['/d', '/s', '/c', ngrokCommand, 'http', '3001', '--authtoken', ngrokAuthtoken] : ['http', '3001', '--authtoken', ngrokAuthtoken];

console.log('[dev:ngrok] Arrancando ngrok para el backend...');
const child = spawn(spawnCommand, spawnArgs, {
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[dev:ngrok] ngrok terminó por señal ${signal}`);
  } else {
    console.log(`[dev:ngrok] ngrok salió con código ${code ?? 0}`);
  }

  process.exitCode = code ?? 0;
});