import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import nodePath from "node:path";

const host = process.env.TAURI_DEV_HOST;

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
          res.setHeader("Cache-Control", "public, max-age=86400");
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
      next();
    });
  },
});

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), kurmojiDictPlugin()],
  clearScreen: false,
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
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      path: "path-browserify",
    },
  },
  optimizeDeps: {
    include: ["kuromoji"],
  },
}));
