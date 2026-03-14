import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

const MAX_VISIBLE_UPLOADS = 8;
const MAX_EXCERPT = 240;

function formatUploadLine(upload: {
  type: string;
  name: string;
  path?: string;
  excerpt?: string;
  originalExt?: string;
}): string {
  const parts = [`- [${upload.type}] ${upload.name}`];
  if (upload.originalExt) {
    parts.push(`原格式: ${upload.originalExt}`);
  }
  if (upload.path) {
    parts.push(`路径: ${upload.path}`);
  }
  if (!upload.path && upload.excerpt) {
    parts.push(`摘录: ${upload.excerpt.slice(0, MAX_EXCERPT)}`);
  }
  return parts.join(" | ");
}

export class SessionUploadsMiddleware implements ActorMiddleware {
  readonly name = "SessionUploads";

  async apply(ctx: ActorRunContext): Promise<void> {
    const uploads = ctx.actorSystem?.getSessionUploadsSnapshot() ?? [];
    if (uploads.length === 0) return;

    const recentUploads = uploads.slice(0, MAX_VISIBLE_UPLOADS);
    const lines = [
      "[系统注入] 当前会话中用户之前上传过的文件仍然可用：",
      ...recentUploads.map((upload) => formatUploadLine(upload)),
      uploads.some((upload) => Boolean(upload.path))
        ? "如需读取原文件，请优先使用上述路径配合 read_file / list_directory / search_in_files 等工具。"
        : "对于没有物理路径的上传项，请基于摘录和当前消息中的上下文继续处理。",
    ];

    ctx.contextMessages = [
      { role: "user", content: lines.join("\n") },
      ...ctx.contextMessages,
    ];
  }
}
