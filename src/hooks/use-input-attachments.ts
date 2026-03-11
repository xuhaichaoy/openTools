import { useCallback, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { handleError } from "@/core/errors";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "tiff", "tif",
]);
const TEXT_EXT = new Set([
  "txt", "md", "json", "yaml", "yml", "toml", "xml", "csv", "log", "ini", "cfg", "conf",
  "js", "ts", "jsx", "tsx", "mjs", "cjs",
  "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "swift", "kt", "rb", "php",
  "sh", "bash", "zsh", "sql", "css", "scss", "less", "html", "htm", "vue", "svelte",
  "dockerfile", "makefile", "cmake", "gradle", "tf", "hcl",
  "r", "m", "lua", "pl", "dart", "scala", "groovy", "zig", "nim", "ex", "exs", "erl",
]);
const DOCUMENT_EXT = new Set([
  "pdf", "doc", "docx", "rtf", "odt", "pptx", "ppt",
]);
const SPREADSHEET_EXT = new Set([
  "xlsx", "xls", "xlsm", "ods",
]);
const MINDMAP_EXT = new Set([
  "xmind", "mm",
]);

/** Unified accept string for all file input components */
export const FILE_ACCEPT_ALL = [
  "image/*",
  ...Array.from(TEXT_EXT).map((e) => `.${e}`),
  ...Array.from(DOCUMENT_EXT).map((e) => `.${e}`),
  ...Array.from(SPREADSHEET_EXT).map((e) => `.${e}`),
  ...Array.from(MINDMAP_EXT).map((e) => `.${e}`),
].join(",");
const MAX_TEXT_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_TEXT_BYTES = 500 * 1024;
const MAX_FOLDER_DEPTH = 2;
const MAX_TREE_NODES = 800;

export interface InputAttachment {
  id: string;
  type: "image" | "text_file" | "document" | "folder";
  name: string;
  path?: string;
  preview?: string;
  textContent?: string;
  size: number;
  /** 文档原始格式，如 pdf/docx */
  originalExt?: string;
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function genId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}


const IGNORED_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", ".next", ".nuxt",
  "dist", "build", "target", "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".DS_Store", ".cache", "coverage",
]);

const IGNORE_FILENAMES = [".gitignore", ".ignore", ".rgignore"];

interface IgnoreRule {
  negated: boolean;
  regex: RegExp;
}

function normalizePathLike(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function globToRegex(glob: string): string {
  let output = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        output += ".*";
        i++;
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      output += "[^/]";
      continue;
    }
    output += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return output;
}

function parseIgnoreRule(rawLine: string): IgnoreRule | null {
  let line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1).trim();
    if (!line) return null;
  }

  const rooted = line.startsWith("/");
  if (rooted) line = line.slice(1);
  const directoryOnly = line.endsWith("/");
  if (directoryOnly) line = line.replace(/\/+$/, "");
  if (!line) return null;

  const hasSlash = line.includes("/");
  const body = globToRegex(line);
  let source = "";

  if (directoryOnly) {
    source = rooted
      ? `^${body}(?:/.*)?$`
      : `(?:^|.*/)${body}(?:/.*)?$`;
  } else if (rooted) {
    source = `^${body}$`;
  } else if (hasSlash) {
    source = `(?:^|.*/)${body}$`;
  } else {
    source = `(?:^|.*/)${body}$`;
  }

  try {
    return {
      negated,
      regex: new RegExp(source),
    };
  } catch {
    return null;
  }
}

function parseIgnoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseIgnoreRule(line);
    if (parsed) rules.push(parsed);
  }
  return rules;
}

async function loadIgnoreRules(rootPath: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const filename of IGNORE_FILENAMES) {
    const path = normalizePathLike(`${rootPath}/${filename}`);
    try {
      const content = await invoke<string>("read_text_file", { path });
      rules.push(...parseIgnoreRules(content));
    } catch {
      // ignore file not found / unreadable
    }
  }
  return rules;
}

function createIgnoreMatcher(rootPath: string, rules: IgnoreRule[]): (absolutePath: string, isDir: boolean) => boolean {
  if (rules.length === 0) return () => false;
  const normalizedRoot = normalizePathLike(rootPath);
  return (absolutePath, isDir) => {
    const fullPath = normalizePathLike(absolutePath);
    let relative = fullPath;
    if (fullPath === normalizedRoot) return false;
    if (fullPath.startsWith(`${normalizedRoot}/`)) {
      relative = fullPath.slice(normalizedRoot.length + 1);
    }
    const candidate = isDir ? relative.replace(/\/+$/, "") : relative;
    if (!candidate) return false;

    let ignored = false;
    for (const rule of rules) {
      if (rule.regex.test(candidate)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

async function buildDirTree(
  dirPath: string,
  depth: number,
  maxDepth: number,
  prefix: string,
  isIgnored: (absolutePath: string, isDir: boolean) => boolean,
  state: { visited: number; truncated: boolean },
): Promise<string> {
  if (depth > maxDepth || state.truncated) return "";
  try {
    const raw = await invoke<string>("list_directory", { path: dirPath });
    let entries = JSON.parse(raw) as { name: string; is_dir: boolean }[];
    entries = entries.filter((e) => {
      if (!e.name || e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) return false;
      const fullPath = normalizePathLike(`${dirPath}/${e.name}`);
      return !isIgnored(fullPath, e.is_dir);
    });
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (state.truncated) break;
      const e = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (state.visited >= MAX_TREE_NODES) {
        state.truncated = true;
        lines.push(`${prefix}${connector}... (目录过大，已截断)`);
        break;
      }

      state.visited += 1;
      lines.push(`${prefix}${connector}${e.name}${e.is_dir ? "/" : ""}`);
      if (e.is_dir && depth < maxDepth && !isIgnored(normalizePathLike(`${dirPath}/${e.name}`), true)) {
        const sub = await buildDirTree(
          `${dirPath}/${e.name}`.replace(/\/+/g, "/"),
          depth + 1,
          maxDepth,
          `${prefix}${childPrefix}`,
          isIgnored,
          state,
        );
        if (sub) lines.push(sub);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

export function useInputAttachments() {
  const [attachments, setAttachments] = useState<InputAttachment[]>([]);
  const [folderRoots, setFolderRoots] = useState<string[]>([]);
  const [folderTree, setFolderTree] = useState("");

  const imagePaths = attachments
    .filter((a) => a.type === "image" && a.path)
    .map((a) => a.path!);
  const imagePreviews = attachments
    .filter((a) => a.type === "image" && a.preview)
    .map((a) => a.preview!);

  const textAttachments = attachments.filter(
    (a) => (a.type === "text_file" || a.type === "document") && a.textContent,
  );

  const detectedRoots = (() => {
    const allPaths = [
      ...folderRoots,
      ...textAttachments.map((a) => a.path).filter(Boolean) as string[],
    ];
    if (allPaths.length === 0) return [];
    if (folderRoots.length > 0) return [...folderRoots];
    const parts = allPaths.map((p) => p.split("/"));
    const common: string[] = [];
    for (let i = 0; i < parts[0].length; i++) {
      const seg = parts[0][i];
      if (parts.every((p) => p[i] === seg)) common.push(seg);
      else break;
    }
    const root = common.join("/");
    return root && root !== "/" ? [root] : [];
  })();

  const fileItems = textAttachments
    .map((a) => `### 📄 ${a.path || a.name}\n\`\`\`\n${a.textContent}\n\`\`\``)
    .join("\n\n---\n\n");

  const hasFolders = folderRoots.length > 0;
  const hasFiles = textAttachments.length > 0;

  const contextHeader = detectedRoots.length > 0
    ? `## 🗂️ 工作上下文\n${detectedRoots.map((r) => `- 项目路径: \`${r}\``).join("\n")}\n\n> ${
        hasFolders && !hasFiles
          ? "用户提供了项目目录（已按 .gitignore/.ignore/.rgignore 过滤），请使用 read_file / list_directory / search_in_files 等工具按需读取文件内容。不要猜测文件内容。"
          : hasFiles
            ? "以下是用户提供的文件内容（路径均为绝对路径），请根据用户指令进行处理。"
            : ""
      }`
    : "";

  const fileContextBlock = [
    contextHeader,
    folderTree ? `## 📂 目录结构\n\`\`\`\n${folderTree}\n\`\`\`` : "",
    fileItems,
  ].filter(Boolean).join("\n\n---\n\n");

  const hasAttachments = attachments.length > 0;

  const addImageFromPath = useCallback(async (path: string, preview?: string) => {
    const name = path.replace(/^.*[/\\]/, "");
    // 如果没有传入预览，读文件生成 blob URL
    let resolvedPreview = preview;
    if (!resolvedPreview) {
      try {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(path);
        const extName = path.split(".").pop()?.toLowerCase() ?? "png";
        const mime =
          extName === "jpg" || extName === "jpeg" ? "image/jpeg" :
          extName === "gif" ? "image/gif" :
          extName === "webp" ? "image/webp" : "image/png";
        const blob = new Blob([bytes], { type: mime });
        resolvedPreview = URL.createObjectURL(blob);
      } catch {
        // 预览失败不影响功能
      }
    }
    setAttachments((prev) => [
      ...prev,
      {
        id: genId(),
        type: "image",
        name,
        path,
        preview: resolvedPreview,
        size: 0,
      },
    ]);
  }, []);

  const addImageFromBlob = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1];
      if (!base64) return;
      const extName = file.type.split("/")[1] || "png";
      const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${extName}`;
      try {
        const filePath = await invoke<string>("ai_save_chat_image", {
          imageData: base64,
          fileName,
        });
        setAttachments((prev) => [
          ...prev,
          {
            id: genId(),
            type: "image",
            name: file.name,
            path: filePath,
            preview: dataUrl,
            size: file.size,
          },
        ]);
      } catch (err) {
        handleError(err, { context: "保存聊天图片", silent: true });
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const addTextFile = useCallback(async (path: string) => {
    const name = path.replace(/^.*[/\\]/, "");
    try {
      const content = await invoke<string>("read_text_file", { path });
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MAX_TEXT_FILE_BYTES) {
        return;
      }
      setAttachments((prev) => {
        const currentTotal = prev
          .filter((a) => a.type === "text_file")
          .reduce((s, a) => s + (a.textContent?.length ?? 0), 0);
        if (currentTotal + bytes > MAX_TOTAL_TEXT_BYTES) return prev;
        return [
          ...prev,
          {
            id: genId(),
            type: "text_file",
            name,
            path,
            textContent: content,
            size: bytes,
          },
        ];
      });
    } catch {
      // skip unreadable or denied path
    }
  }, []);

  const addDocumentFile = useCallback(async (path: string) => {
    const name = path.replace(/^.*[/\\]/, "");
    const extName = ext(name);
    try {
      const content = await invoke<string>("extract_document_text", { path }).catch(() => null);
      if (content) {
        const bytes = new TextEncoder().encode(content).length;
        setAttachments((prev) => {
          const currentTotal = prev
            .filter((a) => a.type === "text_file" || a.type === "document")
            .reduce((s, a) => s + (a.textContent?.length ?? 0), 0);
          if (currentTotal + bytes > MAX_TOTAL_TEXT_BYTES) return prev;
          return [
            ...prev,
            {
              id: genId(),
              type: "document",
              name,
              path,
              textContent: content,
              size: bytes,
              originalExt: extName,
            },
          ];
        });
      } else {
        await addTextFile(path);
      }
    } catch {
      await addTextFile(path);
    }
  }, [addTextFile]);

  const addSpreadsheetFile = useCallback(async (path: string) => {
    const name = path.replace(/^.*[/\\]/, "");
    const extName = ext(name);
    try {
      const content = await invoke<string>("extract_spreadsheet_text", { filePath: path, maxRows: 500 });
      if (content) {
        const bytes = new TextEncoder().encode(content).length;
        setAttachments((prev) => {
          const currentTotal = prev
            .filter((a) => a.type === "text_file" || a.type === "document")
            .reduce((s, a) => s + (a.textContent?.length ?? 0), 0);
          if (currentTotal + bytes > MAX_TOTAL_TEXT_BYTES) return prev;
          return [
            ...prev,
            {
              id: genId(),
              type: "document",
              name,
              path,
              textContent: content,
              size: bytes,
              originalExt: extName,
            },
          ];
        });
        return;
      }
    } catch { /* extraction failed */ }
    await addTextFile(path);
  }, [addTextFile]);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) void addImageFromBlob(blob);
        }
      }
    },
    [addImageFromBlob],
  );

  const addTextFileFromFile = useCallback((file: File, content: string) => {
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > MAX_TEXT_FILE_BYTES) return;
    setAttachments((prev) => {
      const currentTotal = prev
        .filter((a) => a.type === "text_file")
        .reduce((s, a) => s + (a.textContent?.length ?? 0), 0);
      if (currentTotal + bytes > MAX_TOTAL_TEXT_BYTES) return prev;
      return [
        ...prev,
        {
          id: genId(),
          type: "text_file",
          name: file.name,
          textContent: content,
          size: bytes,
        },
      ];
    });
  }, []);

  const handleFileSelectNative = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: "选择文件",
        filters: [
          {
            name: "代码和文本",
            extensions: [
              "txt", "md", "json", "yaml", "yml", "toml", "xml", "csv", "log",
              "js", "ts", "jsx", "tsx", "mjs", "cjs",
              "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "swift", "kt", "rb", "php",
              "sh", "sql", "css", "scss", "less", "html", "htm", "vue", "svelte",
              "dockerfile", "makefile", "ini", "cfg", "conf",
              "r", "lua", "dart", "scala", "groovy", "zig",
            ],
          },
          {
            name: "图片",
            extensions: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif"],
          },
          {
            name: "文档",
            extensions: ["pdf", "doc", "docx", "rtf", "odt", "pptx", "ppt"],
          },
          {
            name: "表格",
            extensions: ["xlsx", "xls", "xlsm", "ods"],
          },
          {
            name: "思维导图",
            extensions: ["xmind", "mm"],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const extName = ext(filePath);
        if (IMAGE_EXT.has(extName)) {
          await addImageFromPath(filePath);
        } else if (SPREADSHEET_EXT.has(extName)) {
          await addSpreadsheetFile(filePath);
        } else if (DOCUMENT_EXT.has(extName) || MINDMAP_EXT.has(extName)) {
          await addDocumentFile(filePath);
        } else {
          await addTextFile(filePath);
        }
      }
    } catch (err) {
      handleError(err, { context: "选择文件", silent: true });
    }
  }, [addImageFromPath, addTextFile, addDocumentFile, addSpreadsheetFile]);

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      e.target.value = "";
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const extName = ext(file.name);
        if (IMAGE_EXT.has(extName)) {
          await addImageFromBlob(file);
        } else if (TEXT_EXT.has(extName)) {
          const content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = reject;
            reader.readAsText(file, "utf-8");
          }).catch(() => "");
          if (content) addTextFileFromFile(file, content);
        } else if (SPREADSHEET_EXT.has(extName) || DOCUMENT_EXT.has(extName) || MINDMAP_EXT.has(extName)) {
          const content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = reject;
            reader.readAsText(file, "utf-8");
          }).catch(() => "");
          if (content) {
            addTextFileFromFile(file, content);
          }
        }
      }
    },
    [addImageFromBlob, addTextFileFromFile],
  );

  const handleFolderSelect = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择文件夹",
      });
      if (!selected || typeof selected !== "string") return;

      setFolderRoots((prev) => prev.includes(selected) ? prev : [...prev, selected]);

      const ignoreRules = await loadIgnoreRules(selected);
      const isIgnored = createIgnoreMatcher(selected, ignoreRules);
      const treeState = { visited: 0, truncated: false };
      const tree = await buildDirTree(
        selected,
        0,
        MAX_FOLDER_DEPTH,
        "",
        isIgnored,
        treeState,
      );
      const treeWithHint = `${selected}/\n${tree}`;
      setFolderTree((prev) => (prev ? `${prev}\n\n${treeWithHint}` : treeWithHint));

      const folderName = selected.replace(/^.*[/\\]/, "") || selected;
      setAttachments((prev) => {
        if (prev.some((a) => a.type === "folder" && a.path === selected)) return prev;
        return [
          ...prev,
          {
            id: genId(),
            type: "folder" as const,
            name: folderName,
            path: selected,
            size: 0,
          },
        ];
      });
    } catch (err) {
      handleError(err, { context: "选择文件夹", silent: true });
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Tauri drag-and-drop: file paths from native side
    const tauriPaths = (e as unknown as { dataTransfer?: { files?: FileList } }).dataTransfer?.files;
    if (tauriPaths && tauriPaths.length > 0) {
      for (let i = 0; i < tauriPaths.length; i++) {
        const file = tauriPaths[i];
        const extName = ext(file.name);
        if (IMAGE_EXT.has(extName)) {
          await addImageFromBlob(file);
        } else if (TEXT_EXT.has(extName) || DOCUMENT_EXT.has(extName) || SPREADSHEET_EXT.has(extName) || MINDMAP_EXT.has(extName)) {
          const content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = reject;
            reader.readAsText(file, "utf-8");
          }).catch(() => "");
          if (content) {
            const bytes = new TextEncoder().encode(content).length;
            if (bytes <= MAX_TEXT_FILE_BYTES) {
              setAttachments((prev) => {
                const currentTotal = prev
                  .filter((a) => a.type === "text_file")
                  .reduce((s, a) => s + (a.textContent?.length ?? 0), 0);
                if (currentTotal + bytes > MAX_TOTAL_TEXT_BYTES) return prev;
                return [
                  ...prev,
                  {
                    id: genId(),
                    type: "text_file" as const,
                    name: file.name,
                    textContent: content,
                    size: bytes,
                  },
                ];
              });
            }
          }
        }
      }
    }
  }, [addImageFromBlob]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removing = prev.find((a) => a.id === id);
      if (removing?.type === "folder" && removing.path) {
        const removedPath = removing.path;
        setFolderRoots((roots) => roots.filter((r) => r !== removedPath));
        setFolderTree((tree) => {
          const lines = tree.split("\n");
          const idx = lines.findIndex((l) => l.startsWith(removedPath));
          if (idx < 0) return tree;
          let end = idx + 1;
          while (end < lines.length && (lines[end].startsWith("│") || lines[end].startsWith("├") || lines[end].startsWith("└") || lines[end].startsWith("  ") || lines[end] === "")) end++;
          lines.splice(idx, end - idx);
          return lines.join("\n").trim();
        });
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
    setFolderRoots([]);
    setFolderTree("");
  }, []);

  const attachmentSummary = (() => {
    const parts: string[] = [];
    const folders = attachments.filter((a) => a.type === "folder");
    const files = attachments.filter((a) => a.type === "text_file" || a.type === "document");
    const images = attachments.filter((a) => a.type === "image");
    for (const f of folders) parts.push(`📂 ${f.path || f.name}`);
    if (files.length > 0) parts.push(`📄 ${files.length} 个文件`);
    if (images.length > 0) parts.push(`🖼️ ${images.length} 张图片`);
    return parts.join("  ");
  })();

  return {
    attachments,
    imagePaths,
    imagePreviews,
    fileContextBlock,
    attachmentSummary,
    hasAttachments,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleFileSelect,
    handleFileSelectNative,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
    addImageFromBlob,
    addImageFromPath,
    addTextFile,
    addSpreadsheetFile,
  };
}
