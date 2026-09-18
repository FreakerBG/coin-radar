// Runs the built Worker exactly as `npm start` does, but on a free local port with a temporary local
// D1 state, so tests can exercise the real HTTP boundary (Wrangler's dev proxy in front of workerd).
// Everything is local: no remote Wrangler or D1 command, no account. Only the process tree and the
// temporary directory created here are ever stopped or removed.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// The `npm start` arguments, with the persisted state directory replaced by a temporary one.
function startArguments(stateDir, port, vars) {
  const [command, ...args] = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).scripts.start.split(/\s+/);
  const persist = args.indexOf('--persist-to');
  if (command !== 'node' || persist < 0 || !args.includes('--local')) throw new Error('Unexpected npm start script: ' + command + ' ' + args.join(' '));
  args[persist + 1] = stateDir;
  return [...args, '--port', String(port), ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`])];
}

function wranglerSync(args, env) {
  const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', ...args], {cwd: projectRoot, env, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

// Live process IDs in the tree: on POSIX the process group led by `root`; on Windows `root`, the
// processes already recorded as belonging to it (which outlive a parent killed first) and their
// descendants.
function treeProcesses(root, recorded = []) {
  if (windows) {
    const listing = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], {encoding: 'utf8'});
    const children = new Map();
    const alive = new Set();
    for (const line of listing.stdout.split(/\r?\n/)) {
      const [pid, parent] = line.trim().split(' ').map(Number);
      if (!pid) continue;
      alive.add(pid);
      children.set(parent, [...(children.get(parent) || []), pid]);
    }
    const found = [...new Set([root, ...recorded])].filter(pid => alive.has(pid));
    for (let i = 0; i < found.length; i++) {
      for (const pid of children.get(found[i]) || []) if (!found.includes(pid)) found.push(pid);
    }
    return found;
  }
  return readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).filter(pid => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) === root;
    } catch {
      return false;
    }
  }).map(Number);
}

function killTree(root, known) {
  if (windows) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(root)], {stdio: 'ignore'});
    for (const pid of known) spawnSync('taskkill', ['/F', '/PID', String(pid)], {stdio: 'ignore'});
  } else {
    try { process.kill(-root, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export async function startBuiltWorker({vars = {}} = {}) {
  if (!existsSync(path.join(projectRoot, 'dist', 'server', 'wrangler.json'))) {
    throw new Error('dist/server/wrangler.json is missing; run `npm run build` first.');
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'coin-radar-worker-'));
  const stateDir = path.join(tempRoot, 'state');
  const env = {
    ...process.env,
    SITES_RUNTIME_ROOT: path.join(tempRoot, 'runtime'),
    // The uncaught stream error is only printed at debug level.
    WRANGLER_LOG: 'debug',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
  let child = null;
  let known = [];
  let log = '';
  const emergencyStop = () => { if (child) killTree(child.pid, known); };

  const worker = {
    port: 0,
    origin: '',
    tempRoot,
    get log() { return log; },
    get alive() { return child !== null && child.exitCode === null && child.signalCode === null; },
    // Stops the tree, confirms that no process in it survived and removes the temporary state.
    async stop() {
      process.off('exit', emergencyStop);
      let survivors = [];
      if (child) {
        known = treeProcesses(child.pid, known);
        killTree(child.pid, known);
        for (let attempt = 0; attempt < 50; attempt++) {
          survivors = treeProcesses(child.pid, known);
          if (!survivors.length) break;
          await sleep(200);
        }
      }
      rmSync(tempRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      return {survivors: [...new Set(survivors)], tempRemoved: !existsSync(tempRoot)};
    },
  };

  try {
    // Migrations go to the temporary local state through a config next to it, as db:migrate:local does.
    const built = JSON.parse(readFileSync(path.join(projectRoot, 'dist', 'server', 'wrangler.json'), 'utf8'));
    const database = built.d1_databases.find(candidate => candidate.binding === 'DB');
    const configFile = path.join(tempRoot, 'wrangler.json');
    writeFileSync(configFile, JSON.stringify({
      name: built.name,
      compatibility_date: built.compatibility_date,
      d1_databases: [{...database, migrations_dir: path.join(projectRoot, 'drizzle')}],
    }));
    wranglerSync(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir, '--config', configFile], env);

    worker.port = await freePort();
    worker.origin = `http://127.0.0.1:${worker.port}`;
    child = spawn(process.execPath, startArguments(stateDir, worker.port, vars), {cwd: projectRoot, env, detached: !windows, stdio: ['ignore', 'pipe', 'pipe']});
    process.on('exit', emergencyStop);
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });

    for (let started = Date.now(); ; await sleep(250)) {
      if (!worker.alive) throw new Error('The Worker exited during startup:\n' + log.slice(-4000));
      if (Date.now() - started > 120000) throw new Error('The Worker did not become ready:\n' + log.slice(-4000));
      try {
        if ((await fetch(worker.origin + '/api/health', {signal: AbortSignal.timeout(2000)})).status === 401) break;
      } catch {
        // Not listening yet.
      }
    }
    known = treeProcesses(child.pid);
    return worker;
  } catch (error) {
    await worker.stop();
    throw error;
  }
}
