#!/usr/bin/env node
// One-time (or rotation) provisioning of the scheduler's two secrets into BOTH secret managers, without
// either value ever appearing in a terminal, a file, a command line or a log:
//   GOLDMINE_CRON_SECRET  -> Vercel production env (sensitive) + Cloudflare Worker secret
//   VERCEL_BYPASS_SECRET  -> a new, dedicated Vercel Protection Bypass for Automation entry (note
//                            "cloudflare-scan-scheduler") + Cloudflare Worker secret
// Values are generated here, held only in this process's memory, and passed to each CLI on stdin. CLI
// stdout is discarded for every call that could echo a value.
//
// Prerequisites: `vercel whoami` and `npx wrangler whoami` both succeed, and the Worker has been deployed
// once (dormant) with `npx wrangler deploy --config scheduler/wrangler.jsonc`.
// Afterwards: GOLDMINE_CRON_SECRET reaches the running Vercel deployment only after the next production
// deployment (Vercel applies env changes to new deployments). Nothing is enabled by this script.
import {spawnSync} from 'node:child_process';
import {randomBytes, randomInt} from 'node:crypto';

const SCOPE = 'vibe-code22';
const PROJECT = 'prj_r6DIyrqTSdEkVOVt7uYuMiCawcII';
const CONFIG = 'scheduler/wrangler.jsonc';
const shell = process.platform === 'win32';

function run(label, command, args, input, {keepStdout = false} = {}) {
  const result = spawnSync(command, args, {input, shell, stdio: ['pipe', keepStdout ? 'pipe' : 'ignore', 'pipe'], encoding: 'utf8'});
  if (result.status !== 0) {
    // stderr from these CLIs never contains the stdin value, but trim it anyway.
    throw new Error(`${label} failed (exit ${result.status}): ${String(result.stderr ?? '').slice(-400)}`);
  }
  console.log(`ok  ${label}`);
  return keepStdout ? result.stdout : '';
}

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const cronSecret = randomBytes(32).toString('hex');
const bypassSecret = Array.from({length: 32}, () => alnum[randomInt(alnum.length)]).join(''); // Vercel requires ^[a-zA-Z0-9]{32}$

run('vercel whoami', 'vercel', ['whoami']);
run('wrangler whoami', 'npx', ['wrangler', 'whoami']);
run('Vercel env GOLDMINE_CRON_SECRET (production, sensitive)', 'vercel', ['env', 'add', 'GOLDMINE_CRON_SECRET', 'production', '--sensitive', '--force', '--scope', SCOPE], cronSecret);
run('Vercel protection bypass "cloudflare-scan-scheduler"', 'vercel', ['api', `/v1/projects/${PROJECT}/protection-bypass`, '-X', 'PATCH', '--input', '-', '--scope', SCOPE, '--silent'],
  JSON.stringify({generate: {secret: bypassSecret, note: 'cloudflare-scan-scheduler'}}));
run('Worker secret GOLDMINE_CRON_SECRET', 'npx', ['wrangler', 'secret', 'put', 'GOLDMINE_CRON_SECRET', '--config', CONFIG], cronSecret);
run('Worker secret VERCEL_BYPASS_SECRET', 'npx', ['wrangler', 'secret', 'put', 'VERCEL_BYPASS_SECRET', '--config', CONFIG], bypassSecret);
console.log('Done. No value was printed. Next: a production deployment so Vercel picks up GOLDMINE_CRON_SECRET (scheduler/README.md).');
