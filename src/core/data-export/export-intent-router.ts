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

const ENTER_DATABASE_OPERATION_MODE_COMMAND = "数据库操作";
const EXIT_DATABASE_OPERATION_MODE_COMMAND = "退出数据库操作";

function normalizeExportRouterText(text?: string | null): string {
  return String(text ?? "")
    .trim()
    .replace(/^\[(?:im|IM):[^\]]+\]\s*/u, "")
    .trim();
}

export function normalizeExportIntentText(text?: string | null): string {
  return normalizeExportRouterText(text);
}

export function isEnterDatabaseOperationModeCommand(text?: string | null): boolean {
  return normalizeExportRouterText(text) === ENTER_DATABASE_OPERATION_MODE_COMMAND;
}

export function isExitDatabaseOperationModeCommand(text?: string | null): boolean {
  return normalizeExportRouterText(text) === EXIT_DATABASE_OPERATION_MODE_COMMAND;
}

export function isExportConfirmation(text?: string | null): boolean {
  const normalized = normalizeExportRouterText(text);
  if (!normalized) return false;
  return EXPORT_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isExportCancellation(text?: string | null): boolean {
  const normalized = normalizeExportRouterText(text);
  if (!normalized) return false;
  return EXPORT_CANCEL_PATTERNS.some((pattern) => pattern.test(normalized));
}
