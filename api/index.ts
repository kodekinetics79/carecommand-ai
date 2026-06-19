// Vercel Serverless Function entry. The real handler is pre-bundled to
// ./_bundle.mjs at build time (see buildCommand in vercel.json) — that bundle
// inlines the whole Fastify server so Node's ESM loader has nothing relative to
// resolve. Files prefixed with "_" in api/ are not treated as separate functions.
// @ts-expect-error _bundle.mjs is generated during the build.
export { default } from './_bundle.mjs';
