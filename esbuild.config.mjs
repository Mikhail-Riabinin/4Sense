import { build, context } from "esbuild";

const isProduction = process.argv.includes("production");

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  target: "es2020",
  platform: "browser",
  sourcemap: !isProduction,
  minify: isProduction,
  external: ["obsidian"],
  logLevel: "info"
};

if (isProduction) {
  await build(buildOptions);
} else {
  const ctx = await context(buildOptions);
  await ctx.watch();
}
