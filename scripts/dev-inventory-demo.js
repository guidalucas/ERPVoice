import { spawn } from 'node:child_process';

const children = [];
let stopping = false;

const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  if (code) process.exitCode = code;
};

const start = (label, args, env = {}) => {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`[demo inventario] ${label} terminó.`);
      stop(code || 1);
    }
  });
};

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

start('catálogo', ['scripts/dev-inventory-fixture.mjs'], { INVENTORY_FIXTURE_PORT: '3002' });
start('frontend', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
  VITE_API_PROXY_TARGET: 'http://127.0.0.1:3002',
});

console.log('[demo inventario] Abrí http://localhost:5174 y usá el acceso de desarrollo.');
