import type { DialogTopSessionItem } from "./DialogChannelBoard";

export function shouldShowDialogTopSessionStrip(items: DialogTopSessionItem[]): boolean {
  return items.some((item) => item.key !== "local");
}
