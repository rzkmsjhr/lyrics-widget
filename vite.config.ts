import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import nodePath from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Serves kuromoji .dat.gz files as raw binary (application/octet-stream)
 * WITHOUT Content-Encoding: gzip, so the browser does NOT auto-decompress them
 * before passing the ArrayBuffer to XHR. Without this, Vite's dev server sets
 * Content-Encoding: gzip and the browser decompresses the file transparently,
 * causing kuromoji's gunzip step to fail with "invalid file signature".
 */
const kurmojiDictPlugin = (): Plugin => ({
  name: "kuromoji-dict",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const match = req.url?.match(/^\/kuromoji\/dict\/([^?]+\.dat\.gz)/);
      if (match) {
        const filePath = nodePath.resolve("./public/kuromoji/dict", match[1]);
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Length", String(stat.size));
          // No Content-Encoding header → browser treats bytes as raw, not compressed
          res.setHeader("Cache-Control", "public, max-age=86400");
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
      next();
    });
  },
});

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), kurmojiDictPlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Alias Node's 'path' to path-browserify so kuromoji's DictionaryLoader.js
  // can call path.join() in the browser without crashing.
  resolve: {
    alias: {
      path: "path-browserify",
    },
  },
  // Pre-bundle kuromoji with esbuild so the browser field (BrowserDictionaryLoader)
  // is resolved instead of the Node.js FileSystemLoader.
  optimizeDeps: {
    include: ["kuromoji"],
  },
}));
