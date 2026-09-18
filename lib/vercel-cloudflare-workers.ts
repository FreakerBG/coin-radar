// Vercel preview builds do not provide Cloudflare Worker bindings. Keep the
// binding object empty so routes fail closed when storage or provider secrets
// are unavailable.
export const env = Object.freeze({}) as Cloudflare.Env;
