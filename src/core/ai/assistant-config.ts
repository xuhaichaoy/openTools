import type { AIConfig } from "./types";

const ADVANCED_TOOL_PATTERNS = [
  /^list_directory$/,
  /^read_file$/,
  /^read_file_range$/,
  /^search_in_files$/,
  /^write_file$/,
  /^export_spreadsheet$/,
  /^str_replace_edit$/,
  /^json_edit$/,
  /^run_shell_command$/,
  /^persistent_shell$/,
  /^get_system_info$/,
  /^open_url$/,
  /^open_path$/,
  /^get_running_processes$/,
  /^run_lint$/,
  /^ckg_/,
];

const NATIVE_TOOL_PATTERNS = [
  /^native_/,
  /^win_open_settings$/,
];

const MEMORY_TOOL_PATTERNS = [
  /^save_user_memory$/,
  /^memory_search$/,
  /^memory_save$/,
];

export function isAdvancedAssistantToolName(name: string): boolean {
  return ADVANCED_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

export function isNativeAssistantToolName(name: string): boolean {
  return NATIVE_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

export function isMemoryAssistantToolName(name: string): boolean {
  return MEMORY_TOOL_PATTERNS.some((pattern) => pattern.test(name));
}

export function filterAssistantToolsByConfig<T extends { name: string }>(
  tools: readonly T[],
  config: AIConfig,
): T[] {
  return tools.filter((tool) => {
    if (!config.enable_advanced_tools && isAdvancedAssistantToolName(tool.name)) {
      return false;
    }
    if (!config.enable_native_tools && isNativeAssistantToolName(tool.name)) {
      return false;
    }
    if (!config.enable_long_term_memory && isMemoryAssistantToolName(tool.name)) {
      return false;
    }
    return true;
  });
}

export function buildAssistantSupplementalPrompt(
  prompt?: string | null,
): string | undefined {
  const normalized = String(prompt || "").trim();
  if (!normalized) return undefined;
  return `## 全局补充指令\n${normalized}`;
}

export function shouldRecallAssistantMemory(config: AIConfig): boolean {
  return config.enable_long_term_memory !== false
    && config.enable_memory_auto_recall !== false;
}

export function shouldAutoSaveAssistantMemory(config: AIConfig): boolean {
  return config.enable_long_term_memory !== false
    && config.enable_memory_auto_save !== false;
}

export function isAssistantKnowledgeAutoSearchEnabled(config: AIConfig): boolean {
  return config.enable_rag_auto_search !== false;
}

export function getAIConfigSourceLabel(source?: AIConfig["source"]): string {
  switch (source || "own_key") {
    case "team":
      return "团队共享";
    case "platform":
      return "平台服务";
    default:
      return "自有 Key";
  }
}

export function describeAssistantConfigBrief(config: AIConfig): string {
  const flags: string[] = [];
  flags.push(config.enable_advanced_tools ? "高级工具开" : "高级工具关");
  flags.push(config.enable_long_term_memory ? "记忆开" : "记忆关");
  flags.push(config.enable_rag_auto_search !== false ? "知识库开" : "知识库关");
  return flags.join(" / ");
}
