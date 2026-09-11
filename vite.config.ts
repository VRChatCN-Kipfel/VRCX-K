import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Do not watch build artifacts. `tauri dev` compiles Rust into
      //    ./target (repo root, outside src-tauri/) and build.rs rebuilds the
      //    host sidecar via bun while this dev server runs. Watching a file
      //    that is mid-write throws EBUSY (-4082) from fs.watch; chokidar
      //    surfaces that as an FSWatcher 'error' and Vite exits, killing the
      //    beforeDevCommand. bun names its transient files
      //    `.<16hex>-<8hex>.bun-build` (`.tmp` for cross-target builds), so a
      //    RegExp covers both where a `*.bun-build` glob would miss `.tmp`.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/node_modules/**",
        "**/.git/**",
        /\.[0-9a-f]{16}-[0-9a-f]{8}\.(?:bun-build|tmp)$/i,
      ],
    },
  },
}));
