import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";

const host = process.env.TAURI_DEV_HOST;

function reactScreenshotsCssAlias() {
  let distCssPath: string | null = null;
  return {
    name: "react-screenshots-css-alias",
    enforce: "pre" as const,
    resolveId(id: string, importer?: string) {
      if (!importer || !importer.includes("react-screenshots")) return null;
      const need =
        id === "./icons/iconfont.css" ||
        id === "./screenshots.css" ||
        id === "./index.css" ||
        id.endsWith("icons/iconfont.css") ||
        id.endsWith("screenshots.css") ||
        id.endsWith("ScreenshotsOperations/index.css");
      if (!need) return null;
      const norm = importer.replace(/\\/g, "/");
      const idx = norm.indexOf("/react-screenshots/");
      if (idx === -1) return null;
      const pkgRoot = path.resolve(
        norm.slice(0, idx + "/react-screenshots".length),
      );
      const distDir = path.join(pkgRoot, "dist", "static", "css");
      if (!distCssPath && fs.existsSync(distDir)) {
        const files = fs
          .readdirSync(distDir)
          .filter((f) => f.startsWith("index.") && f.endsWith(".css"));
        if (files[0]) distCssPath = path.join(distDir, files[0]);
      }
      return distCssPath ? path.resolve(distCssPath) : null;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), reactScreenshotsCssAlias()],
  optimizeDeps: {
    exclude: ["react-screenshots"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5180,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
