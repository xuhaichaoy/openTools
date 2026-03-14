import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const MAX_VISIBLE_UPLOADS = 8;
const MAX_EXCERPT = 240;
const UPLOADS_PROMPT_MARKER = "[系统注入] 会话附件上下文";

function formatUploadLine(upload: {
  type: string;
  name: string;
  path?: string;
  excerpt?: string;
  originalExt?: string;
  parsed?: boolean;
  truncated?: boolean;
  canReadFromPath?: boolean;
  multimodalEligible?: boolean;
}): string {
  const parts = [`- [${upload.type}] ${upload.name}`];
  if (upload.originalExt) {
    parts.push(`原格式: ${upload.originalExt}`);
  }
  if (upload.parsed) {
    parts.push("已解析");
  }
  if (upload.truncated) {
    parts.push("摘录已截断");
  }
  if (upload.multimodalEligible) {
    parts.push("可走多模态");
  }
  if (upload.path) {
    parts.push(`路径: ${upload.path}`);
  }
  if (!upload.path && upload.excerpt) {
    parts.push(`摘录: ${upload.excerpt.slice(0, MAX_EXCERPT)}`);
  }
  if (!upload.canReadFromPath && !upload.excerpt) {
    parts.push("无直接文件路径");
  }
  return parts.join(" | ");
}

export class SessionUploadsMiddleware implements ActorMiddleware {
  readonly name = "SessionUploads";

  async apply(ctx: ActorRunContext): Promise<void> {
    const uploads = ctx.actorSystem?.getSessionUploadsSnapshot() ?? [];
    if (uploads.length === 0) return;

    const recentUploads = uploads.slice(0, MAX_VISIBLE_UPLOADS);
    const imageUploads = recentUploads.filter((upload) => upload.type === "image");
    const fileUploads = recentUploads.filter((upload) => upload.type !== "image");
    const lines = [
      UPLOADS_PROMPT_MARKER,
      "当前会话中已有附件，请优先利用这些附件，不要重复要求用户再次上传。",
      imageUploads.length > 0 ? "" : undefined,
      imageUploads.length > 0 ? "### 图片附件" : undefined,
      ...imageUploads.map((upload) => formatUploadLine(upload)),
      fileUploads.length > 0 ? "" : undefined,
      fileUploads.length > 0 ? "### 文件附件" : undefined,
      ...fileUploads.map((upload) => formatUploadLine(upload)),
      "",
      uploads.some((upload) => Boolean(upload.path))
        ? "如需读取原文件，请优先使用上述路径配合 read_file / list_directory / search_in_files 等工具。"
        : "若没有物理路径，请基于摘录继续处理；需要更多内容时明确说明缺失信息。",
      imageUploads.length > 0
        ? "图片已作为会话附件保留；若当前模型支持视觉能力，可直接结合图片理解，否则请结合文件路径或摘录继续分析。"
        : undefined,
      uploads.length > MAX_VISIBLE_UPLOADS
        ? `其余 ${uploads.length - MAX_VISIBLE_UPLOADS} 个附件已省略展示，但仍保留在会话中。`
        : undefined,
    ].filter(Boolean) as string[];

    ctx.contextMessages = [
      { role: "user", content: lines.join("\n") },
      ...ctx.contextMessages,
    ];
  }
}
