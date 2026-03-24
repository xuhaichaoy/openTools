import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const runtimeTarget = "es2019";
const CHUNK_BASELINE_PATH = path.resolve(
  __dirname,
  "./scripts/chunk-size-baseline.json",
);

const CHUNK_TARGETS = {
  terminal: [
    "/node_modules/@xterm/xterm/",
    "/node_modules/@xterm/addon-fit/",
    "/node_modules/@xterm/addon-web-links/",
    "/src/plugins/builtin/SSHManager/",
  ],
  "editor-markdown": [
    "/node_modules/vditor/",
    "/node_modules/react-markdown/",
    "/node_modules/remark-gfm/",
    "/node_modules/rehype-highlight/",
    "/node_modules/highlight.js/",
  ],
  "workflow-graph": [
    "/node_modules/@xyflow/react/",
    "/node_modules/@dagrejs/dagre/",
    "/src/components/workflows/",
    "/src/core/workflows/",
  ],
  "plugin-market": [
    "/src/components/plugins/PluginMarket",
    "/src/plugins/builtin/ManagementCenter/",
  ],
  "database-client": [
    "/src/plugins/builtin/DatabaseClient/",
    "/src/store/database-store.ts",
    "/src/store/data-export-dataset-store.ts",
    "/src/core/data-export/",
  ],
  "tauri-runtime": ["/node_modules/@tauri-apps/"],
} as const;

function normalizeId(id: string): string {
  return id.split(path.sep).join("/");
}

function resolveManualChunk(id: string): string | undefined {
  const normalized = normalizeId(id);

  for (const [chunkName, markers] of Object.entries(CHUNK_TARGETS)) {
    if (markers.some((marker) => normalized.includes(marker))) {
      return chunkName;
    }
  }

  return undefined;
}

interface ChunkBaseline {
  entryMaxBytes?: number;
}

function readChunkBaseline(): ChunkBaseline | null {
  try {
    const raw = fs.readFileSync(CHUNK_BASELINE_PATH, "utf8");
    return JSON.parse(raw) as ChunkBaseline;
  } catch {
    return null;
  }
}

function chunkMetricsPlugin(): Plugin {
  return {
    name: "chunk-metrics-plugin",
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter(
        (item): item is Extract<typeof item, { type: "chunk" }> =>
          item.type === "chunk",
      );
      const entryChunk = chunks.find((chunk) => chunk.isEntry);
      const baseline = readChunkBaseline();
      const regressions: string[] = [];

      for (const [chunkName, markers] of Object.entries(CHUNK_TARGETS)) {
        const targetChunk = chunks.find(
          (chunk) => chunk.name === chunkName || chunk.fileName.includes(`${chunkName}-`),
        );
        if (!targetChunk) {
          regressions.push(`missing chunk: ${chunkName}`);
          continue;
        }

        if (
          entryChunk &&
          Object.keys(entryChunk.modules).some((moduleId) =>
            markers.some((marker) => normalizeId(moduleId).includes(marker)),
          )
        ) {
          regressions.push(`entry chunk unexpectedly contains ${chunkName} modules`);
        }
      }

      const report = {
        generatedAt: new Date().toISOString(),
        baseline,
        entry: entryChunk
          ? {
              fileName: entryChunk.fileName,
              size: Buffer.byteLength(entryChunk.code),
            }
          : null,
        trackedChunks: chunks
          .filter((chunk) =>
            Object.keys(CHUNK_TARGETS).some(
              (chunkName) => chunk.name === chunkName || chunk.fileName.includes(`${chunkName}-`),
            ),
          )
          .map((chunk) => ({
            name: chunk.name,
            fileName: chunk.fileName,
            size: Buffer.byteLength(chunk.code),
            isEntry: chunk.isEntry,
          })),
        regressions,
      };

      if (
        baseline?.entryMaxBytes != null &&
        entryChunk &&
        Buffer.byteLength(entryChunk.code) > baseline.entryMaxBytes
      ) {
        regressions.push(
          `entry chunk grew: ${Buffer.byteLength(entryChunk.code)} > baseline ${baseline.entryMaxBytes}`,
        );
      }

      this.emitFile({
        type: "asset",
        fileName: "chunk-metrics.json",
        source: JSON.stringify(report, null, 2),
      });

      if (regressions.length > 0) {
        this.error(`Chunk regression detected:\n${regressions.join("\n")}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), chunkMetricsPlugin()],
  esbuild: {
    target: runtimeTarget,
  },
  optimizeDeps: {
    esbuildOptions: {
      target: runtimeTarget,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: runtimeTarget,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return resolveManualChunk(id);
        },
      },
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
