/**
 * 搜索结果构建工具
 * 从 App.tsx 提取的文件结果处理逻辑
 */

/** 格式化文件大小为可读字符串 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const size = bytes / Math.pow(1024, i);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

/** 获取文件类型对应的 CSS 颜色 */
export function getFileColorClass(fileType: string): string {
  switch (fileType) {
    case "folder":
      return "text-yellow-500 bg-yellow-500/10";
    case "image":
      return "text-pink-500 bg-pink-500/10";
    case "video":
      return "text-red-500 bg-red-500/10";
    case "audio":
      return "text-purple-500 bg-purple-500/10";
    case "code":
      return "text-green-500 bg-green-500/10";
    case "text":
    case "document":
      return "text-blue-500 bg-blue-500/10";
    case "archive":
      return "text-amber-500 bg-amber-500/10";
    case "executable":
      return "text-gray-500 bg-gray-500/10";
    default:
      return "text-slate-500 bg-slate-500/10";
  }
}
