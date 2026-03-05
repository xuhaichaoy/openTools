import type { McpServerConfig } from "@/store/mcp-store";

export interface McpMarketTemplate {
  id: string;
  name: string;
  description: string;
  category: "filesystem" | "dev" | "data" | "communication" | "ai" | "other";
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  icon?: string;
  homepage?: string;
}

export const MCP_MARKET_TEMPLATES: McpMarketTemplate[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "读写本地文件系统，支持目录浏览、文件读写、搜索",
    category: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "github",
    name: "GitHub",
    description: "GitHub API 集成 — 仓库、Issue、PR、代码搜索",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "GitLab API 集成 — 项目、MR、Issue 管理",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    envKeys: ["GITLAB_PERSONAL_ACCESS_TOKEN", "GITLAB_API_URL"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack 工作区集成 — 频道消息、搜索、发送",
    category: "communication",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envKeys: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "PostgreSQL 数据库查询、Schema 浏览",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envKeys: ["POSTGRES_CONNECTION_STRING"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "SQLite 数据库查询和管理",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", ""],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Brave 搜索 API — 网页搜索和本地搜索",
    category: "ai",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envKeys: ["BRAVE_API_KEY"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "浏览器自动化 — 网页截图、爬取、交互",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "memory",
    name: "Memory",
    description: "知识图谱式长期记忆存储",
    category: "ai",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "网页内容获取，支持转换为 Markdown",
    category: "other",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "docker",
    name: "Docker",
    description: "Docker 容器管理 — 镜像、容器、网络",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-docker"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Google Drive 文件搜索和读取",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    envKeys: ["GDRIVE_CREDENTIALS"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Notion 工作区集成 — 页面搜索、读写、数据库查询",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "notion-mcp-server"],
    envKeys: ["NOTION_API_KEY"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "动态反思式推理 — 支持修正和分支思维",
    category: "ai",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "everart",
    name: "EverArt",
    description: "AI 图片生成 — 支持多种模型和风格",
    category: "ai",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everart"],
    envKeys: ["EVERART_API_KEY"],
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
];

export function templateToConfig(
  template: McpMarketTemplate,
  envValues: Record<string, string> = {},
): McpServerConfig {
  const env: Record<string, string> = {};
  for (const key of template.envKeys ?? []) {
    if (envValues[key]) env[key] = envValues[key];
  }

  return {
    id: `mcp-${template.id}-${Date.now()}`,
    name: template.name,
    transport: template.transport,
    command: template.command,
    args: template.args ? [...template.args] : undefined,
    url: template.url,
    env: Object.keys(env).length > 0 ? env : undefined,
    enabled: true,
    auto_start: false,
  };
}

export function getTemplatesByCategory(
  category?: McpMarketTemplate["category"],
): McpMarketTemplate[] {
  if (!category) return MCP_MARKET_TEMPLATES;
  return MCP_MARKET_TEMPLATES.filter((t) => t.category === category);
}
