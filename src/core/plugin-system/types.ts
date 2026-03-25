// 插件系统 — 核心类型定义
// 同时兼容 uTools (plugin.json) 和 Rubick (package.json) 格式

/** 插件指令匹配模式 */
export type MatchType = "text" | "regex" | "over" | "img" | "files" | "window";

/** 插件指令 (uTools 的 features[].cmds) */
export interface PluginCommand {
  type: MatchType;
  label: string;
  match?: string; // regex pattern
  minLength?: number;
  maxLength?: number;
}

export interface PluginMatchContext {
  type?: MatchType;
  payload?: unknown;
}

/** 插件功能入口 (uTools 的 features) */
export interface PluginFeature {
  code: string; // 唯一标识
  explain: string; // 功能说明
  cmds: (string | PluginCommand)[]; // 匹配指令（字符串或对象）
  icon?: string; // 功能图标
  platform?: string[]; // 平台限制 ['win', 'darwin', 'linux']
}

/** 插件内嵌工作流定义（简化版 Workflow） */
export interface PluginWorkflowDef {
  name: string;
  icon: string;
  description: string;
  category?: string;
  trigger?: { type: "manual" | "keyword"; keyword?: string };
  steps: {
    id: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    output_var?: string;
  }[];
}

/**
 * 外部插件可声明的权限
 *
 * - clipboard: 读写剪贴板
 * - network:   发起 HTTP 请求
 * - filesystem: 读写本地文件
 * - shell:     执行 Shell 命令
 * - notification: 系统通知
 * - system:    系统级操作（锁屏等）
 */
export type PluginPermission =
  | "clipboard"
  | "network"
  | "filesystem"
  | "shell"
  | "notification"
  | "system";

/** 插件清单 — 统一格式 (兼容 uTools plugin.json + Rubick package.json + HiClow 扩展) */
export interface PluginManifest {
  // 基础信息
  pluginName: string; // 插件名
  description: string; // 描述
  version: string;
  author?: string;
  homepage?: string;
  logo?: string; // 图标路径（相对于插件目录）

  // 入口
  main?: string; // 主入口 HTML
  preload?: string; // preload 脚本路径

  // 功能
  features: PluginFeature[];

  // HiClow 扩展 — 工作流
  workflows?: PluginWorkflowDef[]; // 插件提供的工作流

  // HiClow 扩展 — AI 动作声明（外部插件可被 Agent 调用）
  mtools?: {
    actions?: ExternalPluginAction[];
    /** 插件声明需要的权限（未声明的权限将被拒绝） */
    permissions?: PluginPermission[];
    /** 打开方式：'window'=新窗口（默认）, 'embed'=主窗口内嵌 */
    openMode?: "window" | "embed";
  };

  // 运行时
  pluginType?: "ui" | "system"; // ui=有界面, system=无界面
  development?: {
    main?: string; // 开发模式入口 URL
  };
}

/** 外部插件在 manifest 中声明的 AI 动作 */
export interface ExternalPluginAction {
  name: string;
  description: string;
  parameters?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "object";
      description?: string;
      required?: boolean;
    }
  >;
}

/** 已加载的插件实例 */
export interface PluginInstance {
  id: string;
  manifest: PluginManifest;
  dirPath: string; // 插件目录绝对路径
  enabled: boolean;
  isBuiltin: boolean; // 是否为内置插件
  source?: "builtin" | "official" | "community" | "dev" | string;
  slug?: string;
  isOfficial?: boolean;
  dataProfile?: string;
}

/** 插件匹配结果 */
export interface PluginMatchResult {
  plugin: PluginInstance;
  feature: PluginFeature;
  matchedCmd: string | PluginCommand;
  score: number; // 匹配分数 (用于排序)
}

export interface PluginDevTraceItem {
  pluginId: string;
  method: string;
  callId: number;
  durationMs: number;
  success: boolean;
  error?: string;
  permissionDecision: string;
  permissionReason?: string;
  createdAt: string;
}

export interface PluginDevWatchStatus {
  running: boolean;
  watchedDirs: string[];
  pluginId?: string;
  changedCount: number;
  lastChangedAt?: string;
  lastError?: string;
}

export type PluginCompatCapabilityStatus =
  | "supported"
  | "partial"
  | "not_supported";

export interface PluginCompatMatrixItem {
  capability: string;
  status: PluginCompatCapabilityStatus;
  notes?: string;
}

export interface PluginPreflightReport {
  ok: boolean;
  fileSizeBytes: number;
  manifest: {
    pluginName: string;
    version: string;
    featuresCount: number;
    permissions: string[];
  } | null;
  compatibility: PluginCompatMatrixItem[];
  risks: string[];
}

export interface PluginMarketApp {
  id: string;
  slug: string;
  name: string;
  description: string;
  tag: string;
  version: string;
  installs: number;
  isOfficial?: boolean;
  currentVersion?: string | null;
  packageSizeBytes?: number | null;
}

export interface PluginMarketPackage {
  slug: string;
  version: string;
  packageSha256: string;
  packageSizeBytes: number;
  downloadUrl: string;
  isOfficial: boolean;
}
