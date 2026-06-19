// Ambient type for the build-generated bundle (api/_bundle.mjs, created by the
// esbuild step in vercel.json). Lets api/index.ts re-export it without a
// suppression that would be "unused" once the real bundle exists at build time.
declare module '*/_bundle.mjs' {
  const handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
  export default handler;
}
