import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const freePort = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const waitFor = async (url, child) => {
  for (let i = 0; i < 150; i++) {
    if (child.fixtureStartError || child.exitCode !== null) throw new Error('FIXTURE_CHILD_EXITED');
    const ok = await new Promise(resolve => { const request = http.get(url, response => { response.resume(); resolve(response.statusCode === 200); }); request.on('error', () => resolve(false)); request.setTimeout(500, () => request.destroy()); });
    if (ok) return; await new Promise(resolve => setTimeout(resolve, 100));
  } throw new Error('FIXTURE_STARTUP_TIMEOUT');
};
export async function startCommerceFixture() {
  const tempParent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(tempParent, 'fullmatch-fixture-'));
  const dbDirectory = path.join(directory, 'pg'), pgPort = await freePort(), apiPort = await freePort(), vitePort = await freePort();
  const password = randomBytes(20).toString('hex'), dbName = `fullmatch_fixture_${randomBytes(6).toString('hex')}`;
  const postgres = new EmbeddedPostgres({ databaseDir: dbDirectory, user: 'postgres', password, port: pgPort, persistent: true,
    onLog: () => {}, onError: () => {}, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  const children = []; let stopped = false, admin;
  const stop = async () => {
    if (stopped) return; stopped = true;
    for (const child of children.reverse()) {
      if (child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
    }
    if (admin) await admin.end().catch(() => {});
    if (process.platform === 'win32' && postgres.process) {
      const control = path.join(repo, 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
      await promisify(execFile)(control, ['-D', dbDirectory, '-m', 'fast', '-w', 'stop'], { windowsHide: true }); postgres.process = undefined;
    }
    await postgres.stop();
    const resolved = await fs.realpath(directory);
    if (path.dirname(resolved).toLowerCase() !== tempParent.toLowerCase() || !path.basename(resolved).startsWith('fullmatch-fixture-')) throw new Error('UNSAFE_FIXTURE_CLEANUP_PATH');
    await fs.rm(resolved, { recursive: true, force: true });
  };
  const launch = (file, args, env, cwd = directory) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => { child.fixtureStartError = error; });
    children.push(child); child.stdout.resume(); child.stderr.resume(); return child;
  };
  try {
    await postgres.initialise(); await postgres.start();
    admin = new Client({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${pgPort}/postgres` }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`); await admin.end(); admin = null;
    const connection = `postgresql://postgres:${password}@127.0.0.1:${pgPort}/${dbName}`, manifest = path.join(directory, 'manifest.json');
    const env = { ...process.env, NODE_ENV: 'test', POSTGRES_SSL: 'false', COMMERCE_DATABASE_URL: connection, API_BIND_HOST: '127.0.0.1',
      AUTH_JWT_SECRET: randomBytes(32).toString('hex'), AUTH_DEV_BYPASS: 'false', COMMERCE_MEDIA_ADAPTER: 'local', COMMERCE_MEDIA_DIRECTORY: path.join(directory, 'media'),
      FULLMATCH_FIXTURE_SEED: 'isolated-local-only', FULLMATCH_FIXTURE_MANIFEST: manifest, PORT: String(apiPort), META_WEBHOOK_PORT: String(apiPort),
      META_APP_SECRET: '', META_ACCESS_TOKEN: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', VITE_VOICE_MODEL_API_KEY: '', VOICE_TRANSCRIPTION_API_KEY: '',
      COMMERCE_STUDIO_ORIGIN: `http://127.0.0.1:${vitePort}` };
    for (const key of ['SUPABASE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_CONNECTION_STRING']) env[key] = connection;
    const seed = launch(path.join(repo, 'scripts/fullmatch/seedFixture.js'), [], env);
    const seedCode = await new Promise((resolve, reject) => { seed.once('error', reject); seed.once('close', resolve); });
    if (seedCode !== 0) throw new Error('FIXTURE_SEED_FAILED');
    const metadata = JSON.parse(await fs.readFile(manifest, 'utf8'));
    const api = launch(path.join(repo, 'server/index.js'), [], { ...env, STOCKY_SCHEMA_MODE: 'verify' }); await waitFor(`http://127.0.0.1:${apiPort}/api/health`, api);
    const frontend = launch(path.join(repo, 'node_modules/vite/bin/vite.js'), ['--config', path.join(repo, 'vite.studio.config.ts'), '--port', String(vitePort)], {
      ...process.env, NODE_ENV: 'development', VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }, repo);
    await waitFor(`http://127.0.0.1:${vitePort}/studio.html`, frontend);
    return { ...metadata, url: `http://127.0.0.1:${vitePort}/studio.html`, apiUrl: `http://127.0.0.1:${apiPort}`, connection, stop };
  } catch (error) { await stop(); throw error; }
}
