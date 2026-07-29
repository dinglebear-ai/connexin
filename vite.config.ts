import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { basename } from "node:path";

const input = process.env.INPUT;
if (!input) throw new Error("INPUT environment variable is not set");

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist/app",
    emptyOutDir: !isDevelopment,
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: { input: { [basename(input, ".html")]: input } },
  },
});
