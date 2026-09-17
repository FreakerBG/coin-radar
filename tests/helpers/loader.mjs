// Module resolution hooks for running route handlers under Node's test runner.
// Only runtime boundaries are replaced: Cloudflare bindings and Next request headers.
// Application modules (routes, lib/research-db, lib/advisor, lib/market) load unchanged.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
const mocks = {
  'cloudflare:workers': 'export const env = globalThis.coinRadarTest.env;',
  'next/headers': 'export async function headers(){return globalThis.coinRadarTest.headers;}',
  'next/navigation': 'export function redirect(path){throw new Error("Unexpected redirect to "+path);}',
};

function withTypeScriptExtension(url) {
  if (/\.[cm]?[jt]sx?$/.test(url.pathname)) return url;
  const candidate = new URL(url.href + '.ts');
  return existsSync(fileURLToPath(candidate)) ? candidate : url;
}

export async function resolve(specifier, context, next) {
  if (Object.hasOwn(mocks, specifier)) {
    return {url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true};
  }
  if (specifier.startsWith('@/')) {
    return {url: withTypeScriptExtension(new URL(specifier.slice(2), root)).href, shortCircuit: true};
  }
  if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
    return {url: withTypeScriptExtension(new URL(specifier, context.parentURL)).href, shortCircuit: true};
  }
  return next(specifier, context);
}
