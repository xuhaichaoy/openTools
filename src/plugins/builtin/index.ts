import { lazy } from "react";
import type { MToolsPlugin } from "@/core/plugin-system/plugin-interface";
import {
  Bot,
  Settings,
  Wrench,
  Database,
  Puzzle,
  Pipette,
  Camera,
  QrCode,
  Search,
  Cloud,
  FileText,
  Languages,
  Workflow,
  BookOpen,
  ScanText,
  Zap,
  ClipboardList,
  TextCursorInput,
  Bookmark,
} from "lucide-react";

import { createElement } from "react";

// ── 壳组件 (懒加载) ──
const DevToolbox = lazy(() =>
  import("@/components/tools/DevToolbox").then((m) => ({
    default: m.DevToolbox,
  })),
);
const NoteHub = lazy(() =>
  import("@/components/tools/NoteHub").then((m) => ({
    default: m.NoteHub,
  })),
);
const AICenter = lazy(() =>
  import("@/components/tools/AICenter").then((m) => ({
    default: m.AICenter,
  })),
);

// ── 独立插件 (懒加载) ──
const ScreenCapture = lazy(() =>
  import("@/components/tools/ScreenCapture").then((m) => ({
    default: m.ScreenCapture,
  })),
);
const ScreenTranslatePlugin = lazy(
  () => import("@/plugins/builtin/ScreenTranslate/index"),
);
const WorkflowList = lazy(() =>
  import("@/components/workflows/WorkflowList").then((m) => ({
    default: m.WorkflowList,
  })),
);
const KnowledgeBase = lazy(() =>
  import("@/components/rag/KnowledgeBase").then((m) => ({
    default: m.KnowledgeBase,
  })),
);
const ColorPicker = lazy(() =>
  import("@/components/tools/ColorPicker").then((m) => ({
    default: m.ColorPicker,
  })),
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
const PluginMarket = lazy(() =>
  import("@/components/plugins/PluginMarket").then((m) => ({
    default: m.PluginMarket,
  })),
);
const QRCodePlugin = lazy(() => import("./QRCode/index"));
const ImageSearchPlugin = lazy(() => import("./ImageSearch/index"));
const CloudSyncPlugin = lazy(() => import("./CloudSync/index"));
const OCRPlugin = lazy(() => import("./OCR/index"));
const SystemActionsPlugin = lazy(() => import("./SystemActions/index"));
const ClipboardHistoryPlugin = lazy(() => import("./ClipboardHistory/index"));
const SnippetsPlugin = lazy(() => import("./Snippets/index").then((m) => ({ default: m.Snippets })));
const BookmarksPlugin = lazy(() => import("./Bookmarks/index"));

// ── 所有内置插件定义（14 个） ──

export const builtinPlugins: MToolsPlugin[] = [
  // ── 开发工具箱（JSON + 时间戳 + Base64）──
  {
    id: "dev-toolbox",
    name: "开发工具箱",
    description: "JSON 格式化、时间戳转换、Base64 编解码",
    icon: createElement(Wrench, { className: "w-6 h-6" }),
    color: "text-yellow-500 bg-yellow-500/10",
    category: "工具",
    keywords: [
      "json",
      "格式化",
      "format",
      "校验",
      "压缩",
      "时间戳",
      "timestamp",
      "unix",
      "日期",
      "date",
      "time",
      "base64",
      "编码",
      "解码",
      "encode",
      "decode",
      "开发",
      "dev",
    ],
    viewId: "dev-toolbox",
    render: (props) => createElement(DevToolbox, props),
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

  // ── 截图（融合工具栏：OCR / 贴图 / 编辑 / 保存 / 复制）──
  {
    id: "screen-capture",
    name: "截图",
    description: "截图录屏，选区后直接 OCR / 贴图 / 编辑 / 保存 / 复制",
    icon: createElement(Camera, { className: "w-6 h-6" }),
    color: "text-sky-500 bg-sky-500/10",
    category: "工具",
    keywords: [
      "截图",
      "录屏",
      "screenshot",
      "capture",
      "录制",
      "ocr",
      "贴图",
      "pin",
      "编辑",
      "保存",
      "复制",
    ],
    viewId: "screen-capture",
    render: (props) => createElement(ScreenCapture, props),
    actions: [
      {
        name: "take_screenshot",
        description: "开始区域截图",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("start_capture", {});
          return { info: "截图选区窗口已打开" };
        },
      },
    ],
  },

  // ── OCR（独立结果页）──
  {
    id: "ocr",
    name: "OCR",
    description: "图片文字识别（支持截图直达）",
    icon: createElement(ScanText, { className: "w-6 h-6" }),
    color: "text-amber-500 bg-amber-500/10",
    category: "工具",
    keywords: ["ocr", "文字识别", "提取文字", "图片转文字"],
    viewId: "ocr",
    render: (props) => createElement(OCRPlugin, props),
  },

  // ── 翻译（独立）──
  {
    id: "screen-translate",
    name: "翻译",
    description: "屏幕翻译、实时翻译、多语言",
    icon: createElement(Languages, { className: "w-6 h-6" }),
    color: "text-teal-500 bg-teal-500/10",
    category: "工具",
    keywords: [
      "翻译",
      "translate",
      "屏幕翻译",
      "实时翻译",
      "多语言",
      "language",
    ],
    viewId: "screen-translate",
    render: (props) => createElement(ScreenTranslatePlugin, props),
  },

  // ── 笔记中心（速记 + AI 笔记 + Markdown 编辑）──
  {
    id: "note-hub",
    name: "笔记中心",
    description: "速记录入、AI 生成笔记、Markdown 编辑器",
    icon: createElement(FileText, { className: "w-6 h-6" }),
    color: "text-lime-500 bg-lime-500/10",
    category: "工具",
    keywords: [
      "笔记",
      "notes",
      "markdown",
      "编辑",
      "记录",
      "vditor",
      "录入",
      "capture",
      "速记",
      "mark",
      "ai笔记",
      "笔记生成",
      "智能笔记",
      "总结",
      "note",
    ],
    viewId: "note-hub",
    render: (props) => createElement(NoteHub, props),
    actions: [
      {
        name: "capture_text",
        description: "快速记录一段文字",
        parameters: {
          text: { type: "string", description: "要记录的文字", required: true },
        },
        execute: async ({ text }) => {
          const { createMark } = await import("@/core/database/marks");
          await createMark("text", text as string);
          return { success: true, message: "已录入" };
        },
      },
    ],
  },

  // ── AI 助手（Ask / Agent 双模式）──
  {
    id: "ai-center",
    name: "AI 助手",
    description: "AI 对话、智能 Agent（支持文件操作和 Shell）",
    icon: createElement(Bot, { className: "w-6 h-6" }),
    color: "text-indigo-500 bg-indigo-500/10",
    category: "AI",
    keywords: [
      "ai",
      "对话",
      "chat",
      "助手",
      "agent",
      "智能",
      "react",
      "自动",
    ],
    viewId: "ai-center",
    render: (props) => createElement(AICenter, props),
    actions: [
      {
        name: "read_file",
        description: "读取本地文本文件的内容",
        parameters: {
          path: {
            type: "string",
            description: "文件的绝对路径",
            required: true,
          },
        },
        execute: async ({ path }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("read_text_file", { path });
        },
      },
      {
        name: "write_file",
        description: "将内容写入本地文本文件",
        parameters: {
          path: {
            type: "string",
            description: "文件的绝对路径",
            required: true,
          },
          content: {
            type: "string",
            description: "要写入的文本内容",
            required: true,
          },
        },
        execute: async ({ path, content }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("write_text_file", { path, content });
        },
      },
      {
        name: "list_dir",
        description: "列出目录下的文件和文件夹",
        parameters: {
          path: {
            type: "string",
            description: "目录的绝对路径",
            required: true,
          },
        },
        execute: async ({ path }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("list_directory", { path });
        },
      },
      {
        name: "shell",
        description: "执行 Shell 命令并返回输出结果",
        parameters: {
          command: {
            type: "string",
            description: "要执行的 Shell 命令",
            required: true,
          },
        },
        execute: async ({ command }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("run_shell_command", { command });
        },
      },
    ],
  },

  // ── 工作流（独立）──
  {
    id: "workflows",
    name: "工作流",
    description: "AI 驱动的自动化工作流",
    icon: createElement(Workflow, { className: "w-6 h-6" }),
    color: "text-amber-500 bg-amber-500/10",
    category: "AI",
    keywords: [
      "工作流",
      "workflow",
      "自动化",
      "流程",
      "automation",
    ],
    viewId: "workflows",
    render: (props) => createElement(WorkflowList, props),
  },

  // ── 知识库（独立）──
  {
    id: "knowledge-base",
    name: "知识库",
    description: "文档导入、RAG 检索增强",
    icon: createElement(BookOpen, { className: "w-6 h-6" }),
    color: "text-emerald-500 bg-emerald-500/10",
    category: "AI",
    keywords: [
      "知识库",
      "knowledge",
      "rag",
      "文档",
      "检索",
      "document",
    ],
    viewId: "knowledge-base",
    render: (props) => createElement(KnowledgeBase, props),
  },

  // ── 其他独立插件 ──

  {
    id: "color",
    name: "颜色",
    description: "屏幕取色、调色板、HEX/RGB/HSL",
    icon: createElement(Pipette, { className: "w-6 h-6" }),
    color: "text-pink-500 bg-pink-500/10",
    category: "工具",
    keywords: ["颜色", "color", "取色", "调色板", "hex", "rgb", "hsl"],
    viewId: "color",
    render: (props) => createElement(ColorPicker, props),
  },
  {
    id: "qr-code",
    name: "二维码",
    description: "二维码/条形码识别与生成",
    icon: createElement(QrCode, { className: "w-6 h-6" }),
    color: "text-violet-500 bg-violet-500/10",
    category: "工具",
    keywords: ["二维码", "qrcode", "条形码", "扫码", "生成"],
    viewId: "qr-code",
    render: (props) => createElement(QRCodePlugin, props),
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
    render: (props) => createElement(DataForgeLayout, props),
  },
  {
    id: "image-search",
    name: "以图搜图",
    description: "反向图片搜索 + AI 图片理解",
    icon: createElement(Search, { className: "w-6 h-6" }),
    color: "text-indigo-500 bg-indigo-500/10",
    category: "工具",
    keywords: ["以图搜图", "图片搜索", "image search", "识图", "搜图"],
    viewId: "image-search",
    render: (props) => createElement(ImageSearchPlugin, props),
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
    render: (props) => createElement(SettingsPage, props),
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
    render: (props) => createElement(PluginMarket, props),
  },
  {
    id: "cloud-sync",
    name: "云同步",
    description: "GitHub/Gitee/GitLab/WebDAV 同步",
    icon: createElement(Cloud, { className: "w-6 h-6" }),
    color: "text-sky-500 bg-sky-500/10",
    category: "系统",
    keywords: ["同步", "sync", "云", "github", "gitee", "webdav", "备份"],
    viewId: "cloud-sync",
    render: (props) => createElement(CloudSyncPlugin, props),
  },

  // ── 系统快捷操作 ──
  {
    id: "system-actions",
    name: "系统操作",
    description: "锁屏、深色模式、清空回收站、休眠等系统级操作",
    icon: createElement(Zap, { className: "w-6 h-6" }),
    color: "text-amber-500 bg-amber-500/10",
    category: "系统",
    keywords: [
      "系统", "锁屏", "休眠", "深色", "暗黑", "回收站", "wifi",
      "截图", "静音", "桌面", "system", "lock", "sleep", "dark",
    ],
    viewId: "system-actions",
    render: (props) => createElement(SystemActionsPlugin, props),
    actions: [
      {
        name: "lock_screen",
        description: "锁定屏幕",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          const cmd = navigator.platform.toLowerCase().includes("mac")
            ? "pmset displaysleepnow"
            : "rundll32.exe user32.dll,LockWorkStation";
          return invoke("run_shell_command", { command: cmd });
        },
      },
      {
        name: "toggle_dark_mode",
        description: "切换系统深色模式",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          const cmd = navigator.platform.toLowerCase().includes("mac")
            ? `osascript -e 'tell app "System Events" to tell appearance preferences to set dark mode to not dark mode'`
            : "reg add HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Themes\\\\Personalize /v AppsUseLightTheme /t REG_DWORD /d 0 /f";
          return invoke("run_shell_command", { command: cmd });
        },
      },
      {
        name: "empty_trash",
        description: "清空回收站",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          const cmd = navigator.platform.toLowerCase().includes("mac")
            ? `osascript -e 'tell app "Finder" to empty the trash'`
            : 'PowerShell.exe -Command "Clear-RecycleBin -Force"';
          return invoke("run_shell_command", { command: cmd });
        },
      },
    ],
  },

  // ── 剪贴板历史 ──
  {
    id: "clipboard-history",
    name: "剪贴板",
    description: "剪贴板历史管理，快速搜索与复用",
    icon: createElement(ClipboardList, { className: "w-6 h-6" }),
    color: "text-cyan-500 bg-cyan-500/10",
    category: "工具",
    keywords: [
      "剪贴板", "clipboard", "复制", "粘贴", "历史", "cb",
      "copy", "paste", "history",
    ],
    viewId: "clipboard-history",
    render: (props) => createElement(ClipboardHistoryPlugin, props),
    actions: [
      {
        name: "clipboard_search",
        description: "搜索剪贴板历史记录",
        parameters: {
          keyword: { type: "string", description: "搜索关键词", required: true },
        },
        execute: async ({ keyword }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("clipboard_history_list", {
            search: keyword,
            limit: 10,
          });
        },
      },
      {
        name: "clipboard_latest",
        description: "获取最近的剪贴板记录",
        parameters: {
          count: { type: "number", description: "获取条数（默认5）", required: false },
        },
        execute: async ({ count }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("clipboard_history_list", {
            search: null,
            limit: (count as number) || 5,
          });
        },
      },
    ],
  },

  // ── 快捷短语 / 文本片段 ──
  {
    id: "snippets",
    name: "快捷短语",
    description: "文本片段管理，支持静态模板和 AI 动态生成",
    icon: createElement(TextCursorInput, { className: "w-6 h-6" }),
    color: "text-emerald-500 bg-emerald-500/10",
    category: "工具",
    keywords: [
      "快捷短语", "文本片段", "snippets", "模板", "template",
      "短语", "snippet", "sn", "快捷", "文本", "签名",
    ],
    viewId: "snippets",
    render: (props) => createElement(SnippetsPlugin, props),
    actions: [
      {
        name: "snippet_search",
        description: "搜索快捷短语，返回匹配的片段列表",
        parameters: {
          query: { type: "string", description: "搜索关键词", required: true },
        },
        execute: async ({ query }) => {
          const { useSnippetStore } = await import("@/store/snippet-store");
          useSnippetStore.getState().loadSnippets();
          return useSnippetStore.getState().searchSnippets(query as string);
        },
      },
      {
        name: "snippet_get_content",
        description: "获取指定快捷短语的内容（静态片段直接返回，动态片段需要 AI 生成）",
        parameters: {
          keyword: { type: "string", description: "短语的触发关键词", required: true },
        },
        execute: async ({ keyword }, { ai }) => {
          const { useSnippetStore } = await import("@/store/snippet-store");
          useSnippetStore.getState().loadSnippets();
          const snippet = useSnippetStore.getState().matchByKeyword(keyword as string);
          if (!snippet) return { error: `未找到关键词为「${keyword}」的短语` };
          if (snippet.isDynamic && snippet.dynamicPrompt) {
            const result = await ai.chat({
              messages: [
                { role: "system", content: "根据提示词生成内容，直接输出，不要解释。" },
                { role: "user", content: snippet.dynamicPrompt },
              ],
            });
            return { title: snippet.title, content: result.content.trim(), dynamic: true };
          }
          return { title: snippet.title, content: snippet.content, dynamic: false };
        },
      },
    ],
  },

  // ── 网页书签 ──
  {
    id: "bookmarks",
    name: "网页书签",
    description: "书签管理，支持从 Chrome/Firefox 导入",
    icon: createElement(Bookmark, { className: "w-6 h-6" }),
    color: "text-blue-500 bg-blue-500/10",
    category: "工具",
    keywords: [
      "书签", "bookmark", "网址", "收藏", "链接", "url",
      "bk", "网页", "导航", "chrome", "firefox",
    ],
    viewId: "bookmarks",
    render: (props) => createElement(BookmarksPlugin, props),
    actions: [
      {
        name: "bookmark_search",
        description: "搜索网页书签，返回匹配的书签列表",
        parameters: {
          query: { type: "string", description: "搜索关键词", required: true },
        },
        execute: async ({ query }) => {
          const { useBookmarkStore } = await import("@/store/bookmark-store");
          useBookmarkStore.getState().loadBookmarks();
          const results = useBookmarkStore.getState().searchBookmarks(query as string);
          return results.map((b) => ({ title: b.title, url: b.url, category: b.category }));
        },
      },
      {
        name: "bookmark_open",
        description: "打开指定书签的网址",
        parameters: {
          url: { type: "string", description: "要打开的网址", required: true },
        },
        execute: async ({ url }) => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("open_url", { url });
          return `已打开: ${url}`;
        },
      },
    ],
  },
];
