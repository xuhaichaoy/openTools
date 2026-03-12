/**
 * CodeSearchTools — Agent 可用的代码搜索工具
 *
 * 灵感来源：cocoindex-code 的 MCP search tool
 *
 * 为 Agent 提供 search_codebase / index_codebase 工具：
 * - search_codebase: 自然语言搜索代码（语义搜索）
 * - index_codebase: 触发代码库索引（增量）
 * - code_index_stats: 查看索引状态
 *
 * 可直接作为 Agent 工具使用，也可通过 MCP Server 暴露。
 */

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { getCodeIndexer, type CodeSearchResult } from "./code-indexer";

function formatSearchResults(results: CodeSearchResult[]): string {
  if (results.length === 0) return "未找到匹配的代码。";

  return results.map((r, i) => {
    const header = `### ${i + 1}. ${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}`;
    const meta = [
      `语言: ${r.chunk.language}`,
      r.chunk.symbolName ? `符号: ${r.chunk.symbolName}` : null,
      `类型: ${r.chunk.chunkType}`,
      `相似度: ${(r.score * 100).toFixed(1)}%`,
    ].filter(Boolean).join(" | ");
    return `${header}\n${meta}\n\`\`\`${r.chunk.language}\n${r.chunk.content}\n\`\`\``;
  }).join("\n\n");
}

export function createCodeSearchTools(projectId: string, rootPath: string): AgentTool[] {
  return [
    {
      name: "search_codebase",
      description:
        "语义搜索代码库。使用自然语言描述你要找的代码功能，" +
        "返回匹配的代码片段（函数、类、模块等）及其文件路径和行号。\n" +
        "示例查询: '处理用户认证的函数', 'WebSocket 连接管理', '数据库迁移逻辑'",
      parameters: {
        query: { type: "string", description: "自然语言搜索查询", required: true },
        language: { type: "string", description: "按语言过滤 (typescript/python/rust/go 等)", required: false },
        path_filter: { type: "string", description: "路径过滤 (如 'src/core/' 或 '*.test.ts')", required: false },
        top_k: { type: "number", description: "返回结果数量，默认 5", required: false },
      },
      readonly: true,
      execute: async (params) => {
        const indexer = getCodeIndexer(projectId, rootPath);
        const query = String(params.query ?? "");
        if (!query.trim()) return { error: "查询不能为空" };

        const results = await indexer.search(query, {
          topK: params.top_k ? Number(params.top_k) : 5,
          language: params.language ? String(params.language) : undefined,
          pathGlob: params.path_filter ? String(params.path_filter) : undefined,
        });

        return {
          results: results.map((r) => ({
            file: r.chunk.filePath,
            lines: `${r.chunk.startLine}-${r.chunk.endLine}`,
            language: r.chunk.language,
            symbol: r.chunk.symbolName,
            type: r.chunk.chunkType,
            score: r.score,
            code: r.chunk.content,
          })),
          formatted: formatSearchResults(results),
          total: results.length,
        };
      },
    },
    {
      name: "index_codebase",
      description:
        "触发代码库索引（增量更新）。只对变更的文件重新索引。" +
        "首次索引可能需要较长时间，后续更新很快。",
      parameters: {
        directory: { type: "string", description: "要索引的目录路径（默认为项目根目录）", required: false },
      },
      readonly: true,
      execute: async (params) => {
        const indexer = getCodeIndexer(projectId, rootPath);
        const dir = params.directory ? String(params.directory) : undefined;

        try {
          const result = await indexer.indexDirectory(dir);
          return {
            success: true,
            indexed: result.indexed,
            skipped: result.skipped,
            totalChunks: result.total,
            stats: indexer.stats,
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: "code_index_stats",
      description: "查看代码索引的当前状态：已索引文件数、代码块数、支持的语言。",
      parameters: {},
      readonly: true,
      execute: async () => {
        const indexer = getCodeIndexer(projectId, rootPath);
        return indexer.stats;
      },
    },
  ];
}
