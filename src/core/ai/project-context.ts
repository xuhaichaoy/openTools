import { invoke } from "@tauri-apps/api/core";
import { addMemoryFromAgent } from "./memory-store";

interface CKGResult {
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  signature?: string;
}

interface ProjectContextSummary {
  rootPath: string;
  languages: string[];
  keyClasses: string[];
  keyFunctions: string[];
  indexedAt: number;
}

let lastIndexedPath = "";
let indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export async function indexProjectContext(rootPath: string): Promise<ProjectContextSummary> {
  // Leverage existing CKG (Code Knowledge Graph) for tree-sitter based indexing
  try {
    await invoke("ckg_index_project", { projectPath: rootPath });
  } catch {
    // CKG may not be available for all projects
  }

  const languages = new Set<string>();
  const keyClasses: string[] = [];
  const keyFunctions: string[] = [];

  // Search for key classes
  try {
    const classes = await invoke<CKGResult[]>("ckg_search_class", {
      query: "",
      limit: 30,
    });
    for (const cls of classes) {
      languages.add(cls.language);
      keyClasses.push(`${cls.name} (${cls.file_path})`);
    }
  } catch { /* ignore */ }

  // Search for key functions
  try {
    const functions = await invoke<CKGResult[]>("ckg_search_function", {
      query: "",
      limit: 30,
    });
    for (const fn of functions) {
      languages.add(fn.language);
      keyFunctions.push(`${fn.name} (${fn.file_path})`);
    }
  } catch { /* ignore */ }

  const summary: ProjectContextSummary = {
    rootPath,
    languages: [...languages],
    keyClasses: keyClasses.slice(0, 20),
    keyFunctions: keyFunctions.slice(0, 20),
    indexedAt: Date.now(),
  };

  // Save as project_context memory
  const contextLines: string[] = [
    `项目路径: ${rootPath}`,
    `语言: ${summary.languages.join(", ")}`,
  ];
  if (summary.keyClasses.length > 0) {
    contextLines.push(`关键类: ${summary.keyClasses.slice(0, 10).join(", ")}`);
  }
  if (summary.keyFunctions.length > 0) {
    contextLines.push(`关键函数: ${summary.keyFunctions.slice(0, 10).join(", ")}`);
  }

  await addMemoryFromAgent(
    `项目结构 (${rootPath.split("/").pop()})`,
    contextLines.join("; "),
    "project_context" as string,
    {
      scope: "workspace",
      workspaceId: rootPath,
      source: "system",
    },
  );

  lastIndexedPath = rootPath;
  return summary;
}

export function indexProjectContextDebounced(rootPath: string, delayMs = 30000): void {
  if (rootPath === lastIndexedPath) return;
  if (indexDebounceTimer) clearTimeout(indexDebounceTimer);
  indexDebounceTimer = setTimeout(() => {
    indexProjectContext(rootPath).catch(() => {});
  }, delayMs);
}
