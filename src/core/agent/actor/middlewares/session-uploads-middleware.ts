import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const MAX_VISIBLE_UPLOADS = 8;
const MAX_EXCERPT = 240;
const UPLOADS_PROMPT_MARKER = "[系统注入] 会话附件上下文";

function isTextLikeImageUpload(upload: {
  type: string;
  originalExt?: string;
  multimodalEligible?: boolean;
}): boolean {
  return upload.type === "image" && upload.multimodalEligible && upload.originalExt?.toLowerCase() === ".svg";
}

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
  const shouldHideImagePath = upload.multimodalEligible && !isTextLikeImageUpload(upload);
  if (upload.path && !shouldHideImagePath) {
    parts.push(`路径: ${upload.path}`);
  } else if (upload.path && shouldHideImagePath) {
    parts.push("图片路径已隐藏，避免误用文本工具读取二进制");
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
    const textLikeImageUploads = imageUploads.filter((upload) => isTextLikeImageUpload(upload));
    const binaryImageUploads = imageUploads.filter((upload) => !isTextLikeImageUpload(upload));
    const hasReadableTextPath =
      fileUploads.some((upload) => Boolean(upload.path))
      || textLikeImageUploads.some((upload) => Boolean(upload.path));
    const hasTextExcerptOnly =
      fileUploads.some((upload) => !upload.path && Boolean(upload.excerpt))
      || textLikeImageUploads.some((upload) => !upload.path && Boolean(upload.excerpt));
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
      hasReadableTextPath
        ? "如需读取文本类附件原文，请优先使用上述路径配合 read_file / read_file_range / search_in_files 等工具。"
        : hasTextExcerptOnly
          ? "文本类附件当前只保留了摘录，请先基于摘录继续处理；如果需要更多内容，再明确说明缺失信息。"
          : undefined,
      binaryImageUploads.length > 0
        ? "图片附件不要使用 read_file / read_file_range 读取本地路径；若当前模型支持视觉能力，请直接基于已附带图片分析。若当前模型不支持视觉，请明确说明当前无法直接读取图片内容，而不是把图片当文本文件。"
        : textLikeImageUploads.length > 0
          ? "SVG 这类文本型图片附件可以按需使用 read_file / read_file_range；其他普通图片仍应优先直接走多模态分析。"
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
