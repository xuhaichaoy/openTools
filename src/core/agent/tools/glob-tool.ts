import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "../actor/types";

export const GLOB_TOOL_NAME = "glob";

export interface GlobInput {
  pattern: string;
  path?: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const source = escapeRegex(normalized)
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${source}$`);
}

async function walkDirectory(root: string, current: string, output: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(root, fullPath, output);
      continue;
    }
    output.push(relative(root, fullPath).replace(/\\/g, "/"));
  }
}

export function createGlobTool(): ToolDefinition {
  return {
    name: GLOB_TOOL_NAME,
    description: "Find files by pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern like **/*.ts" },
        path: { type: "string", description: "Directory to search" },
      },
      required: ["pattern"],
    },
    handler: async (input: GlobInput) => {
      const root = input.path || process.cwd();
      const files: string[] = [];
      await walkDirectory(root, root, files);
      const matcher = globToRegExp(input.pattern);
      const matched = files.filter((file) => matcher.test(file));
      return { files: matched, count: matched.length };
    },
  };
}
