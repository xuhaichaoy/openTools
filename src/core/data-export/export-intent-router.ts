const EXPORT_INTENT_PATTERNS = [
  /导出/u,
  /下载/u,
  /报表/u,
  /明细/u,
  /csv/i,
  /excel/i,
  /xlsx/i,
  /发我/u,
  /给我.*数据/u,
  /给我.*报表/u,
  /查.*并发/u,
];

const EXPORT_CONFIRM_PATTERNS = [
  /^确认/u,
  /确认导出/u,
  /^继续$/u,
  /^可以$/u,
  /导出吧/u,
  /开始导出/u,
];

const EXPORT_CANCEL_PATTERNS = [
  /^取消$/u,
  /取消导出/u,
  /停止导出/u,
  /不用了/u,
  /算了/u,
];

export function isLikelyExportIntent(text?: string | null): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  return EXPORT_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isExportConfirmation(text?: string | null): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  return EXPORT_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isExportCancellation(text?: string | null): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  return EXPORT_CANCEL_PATTERNS.some((pattern) => pattern.test(normalized));
}
