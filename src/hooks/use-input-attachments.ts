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
  "pdf", "doc", "docx", "rtf", "odt",
]);
const MAX_TEXT_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_TEXT_BYTES = 500 * 1024;
const MAX_FOLDER_DEPTH = 3;
const MAX_FOLDER_FILES = 50;

export interface InputAttachment {
  id: string;
  type: "image" | "text_file" | "document";
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

async function collectFilesFromDir(
  dirPath: string,
  depth: number,
  maxDepth: number,
  maxFiles: number,
  collected: { path: string; name: string; isDir: boolean }[],
): Promise<void> {
  if (depth > maxDepth || collected.length >= maxFiles) return;
  try {
    const raw = await invoke<string>("list_directory", { path: dirPath });
    const entries = JSON.parse(raw) as { name: string; is_dir: boolean }[];
    for (const e of entries) {
      if (collected.length >= maxFiles) break;
      const fullPath = `${dirPath}/${e.name}`.replace(/\/+/g, "/");
      if (e.is_dir) {
        await collectFilesFromDir(fullPath, depth + 1, maxDepth, maxFiles, collected);
      } else {
        collected.push({ path: fullPath, name: e.name, isDir: false });
      }
    }
  } catch {
    // ignore single dir read errors
  }
}

export function useInputAttachments() {
  const [attachments, setAttachments] = useState<InputAttachment[]>([]);

  const imagePaths = attachments
    .filter((a) => a.type === "image" && a.path)
    .map((a) => a.path!);
  const imagePreviews = attachments
    .filter((a) => a.type === "image" && a.preview)
    .map((a) => a.preview!);

  const fileContextBlock = attachments
    .filter((a) => (a.type === "text_file" || a.type === "document") && a.textContent)
    .map((a) => `### ${a.name}\n${a.textContent}`)
    .join("\n\n---\n\n");

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
        } else if (DOCUMENT_EXT.has(extName)) {
          // 文档文件需要通过原生后端路径处理
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
      const collected: { path: string; name: string; isDir: boolean }[] = [];
      await collectFilesFromDir(
        selected,
        0,
        MAX_FOLDER_DEPTH,
        MAX_FOLDER_FILES,
        collected,
      );
      for (const f of collected) {
        const extName = ext(f.name);
        if (IMAGE_EXT.has(extName)) {
          await addImageFromPath(f.path);
        } else if (TEXT_EXT.has(extName)) {
          await addTextFile(f.path);
        } else if (DOCUMENT_EXT.has(extName)) {
          await addDocumentFile(f.path);
        }
      }
    } catch (err) {
      handleError(err, { context: "选择文件夹", silent: true });
    }
  }, [addImageFromPath, addTextFile, addDocumentFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  return {
    attachments,
    imagePaths,
    imagePreviews,
    fileContextBlock,
    hasAttachments,
    handlePaste,
    handleFileSelect,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
    addImageFromBlob,
    addImageFromPath,
  };
}
