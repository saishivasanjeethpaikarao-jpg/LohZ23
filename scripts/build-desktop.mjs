import { build } from "esbuild";

await build({ entryPoints: ["desktop/main.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: "dist-desktop/main.cjs", sourcemap: true });
await build({ entryPoints: ["desktop/preload.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: "dist-desktop/preload.cjs", sourcemap: true });
await build({ entryPoints: ["windows-agent/index.ts"], bundle: true, platform: "node", format: "cjs", outfile: "dist/windows-agent.cjs", sourcemap: true });
console.log("Desktop process bundles built.");
