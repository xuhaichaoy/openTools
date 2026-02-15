import { lazy } from "react";
import type { MToolsPlugin } from "@/core/plugin-system/plugin-interface";
import {
  Bot,
  Settings,
  Wrench,
  Clock,
  Hash,
  Database,
  Puzzle,
  BookOpen,
  Workflow,
  Pipette,
  Camera,
  LayoutGrid,
} from "lucide-react";

// React.lazy 按需加载各工具组件
const ChatView = lazy(() =>
  import("@/components/ai/ChatView").then((m) => ({ default: m.ChatView })),
);
const DataForgeLayout = lazy(() =>
  import("@/components/data-forge/DataForgeLayout").then((m) => ({
    default: m.DataForgeLayout,
  })),
);
const SettingsPage = lazy(() =>
  import("@/components/settings/SettingsPage").then((m) => ({
    default: m.SettingsPage,
  })),
);
const JsonFormatter = lazy(() =>
  import("@/components/tools/JsonFormatter").then((m) => ({
    default: m.JsonFormatter,
  })),
);
const TimestampConverter = lazy(() =>
  import("@/components/tools/TimestampConverter").then((m) => ({
    default: m.TimestampConverter,
  })),
);
const Base64Tool = lazy(() =>
  import("@/components/tools/Base64Tool").then((m) => ({
    default: m.Base64Tool,
  })),
);
const ColorPicker = lazy(() =>
  import("@/components/tools/ColorPicker").then((m) => ({
    default: m.ColorPicker,
  })),
);
const ScreenCapture = lazy(() =>
  import("@/components/tools/ScreenCapture").then((m) => ({
    default: m.ScreenCapture,
  })),
);
const KnowledgeBase = lazy(() =>
  import("@/components/rag/KnowledgeBase").then((m) => ({
    default: m.KnowledgeBase,
  })),
);
const WorkflowList = lazy(() =>
  import("@/components/workflows/WorkflowList").then((m) => ({
    default: m.WorkflowList,
  })),
);
const PluginMarket = lazy(() =>
  import("@/components/plugins/PluginMarket").then((m) => ({
    default: m.PluginMarket,
  })),
);

// ── 所有内置插件定义 ──

import { createElement } from "react";

export const builtinPlugins: MToolsPlugin[] = [
  {
    id: "json-formatter",
    name: "JSON",
    description: "JSON 格式化、校验、压缩",
    icon: createElement(Hash, { className: "w-6 h-6" }),
    color: "text-yellow-500 bg-yellow-500/10",
    category: "工具",
    keywords: ["json", "格式化", "format", "校验", "压缩"],
    viewId: "json",
    render: ({ onBack }) => createElement(JsonFormatter, { onBack }),
    actions: [
      {
        name: "json_format",
        description: "格式化 JSON 字符串，使其更易读",
        parameters: {
          input: { type: "string", description: "JSON 字符串", required: true },
        },
        execute: async ({ input }) => {
          try {
            return JSON.stringify(JSON.parse(input as string), null, 2);
          } catch {
            return { error: "JSON 解析失败" };
          }
        },
      },
      {
        name: "json_minify",
        description: "压缩 JSON 字符串，移除空格换行",
        parameters: {
          input: { type: "string", description: "JSON 字符串", required: true },
        },
        execute: async ({ input }) => {
          try {
            return JSON.stringify(JSON.parse(input as string));
          } catch {
            return { error: "JSON 解析失败" };
          }
        },
      },
    ],
  },
  {
    id: "timestamp",
    name: "时间戳",
    description: "Unix 时间戳 ⟷ 日期时间",
    icon: createElement(Clock, { className: "w-6 h-6" }),
    color: "text-green-500 bg-green-500/10",
    category: "工具",
    keywords: ["时间戳", "timestamp", "unix", "日期", "date", "time"],
    viewId: "timestamp",
    render: ({ onBack }) => createElement(TimestampConverter, { onBack }),
    actions: [
      {
        name: "timestamp_now",
        description: "获取当前 Unix 时间戳",
        execute: async () => ({
          timestamp: Math.floor(Date.now() / 1000),
          iso: new Date().toISOString(),
        }),
      },
      {
        name: "timestamp_convert",
        description: "将 Unix 时间戳转换为可读日期，或将日期转为时间戳",
        parameters: {
          input: {
            type: "string",
            description: "时间戳或日期字符串",
            required: true,
          },
        },
        execute: async ({ input }) => {
          const n = Number(input);
          if (!isNaN(n)) {
            const ms = n > 1e12 ? n : n * 1000;
            return {
              date: new Date(ms).toISOString(),
              timestamp: Math.floor(ms / 1000),
            };
          }
          const d = new Date(input as string);
          return {
            date: d.toISOString(),
            timestamp: Math.floor(d.getTime() / 1000),
          };
        },
      },
    ],
  },
  {
    id: "base64",
    name: "Base64",
    description: "Base64 编码 / 解码",
    icon: createElement(Wrench, { className: "w-6 h-6" }),
    color: "text-blue-500 bg-blue-500/10",
    category: "工具",
    keywords: ["base64", "编码", "解码", "encode", "decode"],
    viewId: "base64",
    render: ({ onBack }) => createElement(Base64Tool, { onBack }),
    actions: [
      {
        name: "base64_encode",
        description: "将文本编码为 Base64",
        parameters: {
          input: { type: "string", description: "待编码文本", required: true },
        },
        execute: async ({ input }) =>
          btoa(unescape(encodeURIComponent(input as string))),
      },
      {
        name: "base64_decode",
        description: "将 Base64 解码为文本",
        parameters: {
          input: {
            type: "string",
            description: "Base64 字符串",
            required: true,
          },
        },
        execute: async ({ input }) => {
          try {
            return decodeURIComponent(escape(atob(input as string)));
          } catch {
            return { error: "无效的 Base64 字符串" };
          }
        },
      },
    ],
  },
  {
    id: "color",
    name: "颜色",
    description: "屏幕取色、调色板、HEX/RGB/HSL",
    icon: createElement(Pipette, { className: "w-6 h-6" }),
    color: "text-pink-500 bg-pink-500/10",
    category: "工具",
    keywords: ["颜色", "color", "取色", "调色板", "hex", "rgb", "hsl"],
    viewId: "color",
    render: ({ onBack }) => createElement(ColorPicker, { onBack }),
  },
  {
    id: "screen-capture",
    name: "截图录屏",
    description: "区域截图、滚动长截图、屏幕录制",
    icon: createElement(Camera, { className: "w-6 h-6" }),
    color: "text-sky-500 bg-sky-500/10",
    category: "工具",
    keywords: ["截图", "录屏", "screenshot", "capture", "录制"],
    viewId: "screen-capture",
    render: ({ onBack }) => createElement(ScreenCapture, { onBack }),
  },
  {
    id: "data-forge",
    name: "数据工坊",
    description: "AI 驱动的数据导入导出平台",
    icon: createElement(Database, { className: "w-6 h-6" }),
    color: "text-purple-500 bg-purple-500/10",
    category: "数据",
    keywords: ["数据", "data", "导入", "导出", "工坊", "forge"],
    viewId: "data-forge",
    render: ({ onBack }) => createElement(DataForgeLayout, { onBack }),
  },
  {
    id: "knowledge-base",
    name: "知识库",
    description: "本地文档向量检索增强",
    icon: createElement(BookOpen, { className: "w-6 h-6" }),
    color: "text-emerald-500 bg-emerald-500/10",
    category: "AI",
    keywords: ["知识库", "knowledge", "rag", "文档", "检索"],
    viewId: "knowledge-base",
    render: ({ onBack }) => createElement(KnowledgeBase, { onBack }),
  },
  {
    id: "workflows",
    name: "工作流",
    description: "多步骤自动化流程",
    icon: createElement(Workflow, { className: "w-6 h-6" }),
    color: "text-teal-500 bg-teal-500/10",
    category: "AI",
    keywords: ["工作流", "workflow", "自动化", "流程"],
    viewId: "workflows",
    render: ({ onBack }) => createElement(WorkflowList, { onBack }),
  },
  {
    id: "plugins",
    name: "插件",
    description: "兼容 uTools / Rubick 格式",
    icon: createElement(Puzzle, { className: "w-6 h-6" }),
    color: "text-orange-500 bg-orange-500/10",
    category: "系统",
    keywords: ["插件", "plugin", "utools", "rubick"],
    viewId: "plugins",
    render: ({ onBack }) => createElement(PluginMarket, { onBack }),
  },
  {
    id: "settings",
    name: "设置",
    description: "AI 模型配置、快捷键、通用设置",
    icon: createElement(Settings, { className: "w-6 h-6" }),
    color: "text-gray-500 bg-gray-500/10",
    category: "系统",
    keywords: ["设置", "settings", "配置", "快捷键"],
    viewId: "settings",
    render: ({ onBack }) => createElement(SettingsPage, { onBack }),
  },
  {
    id: "all-features",
    name: "全部功能",
    description: "查看所有可用工具和功能",
    icon: createElement(LayoutGrid, { className: "w-6 h-6" }),
    color: "text-cyan-500 bg-cyan-500/10",
    category: "系统",
    keywords: ["全部", "all", "功能"],
    viewId: "home",
    render: () => null, // handled specially by App shell
  },
];
