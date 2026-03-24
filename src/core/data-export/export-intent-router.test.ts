import { describe, expect, it } from "vitest";
import {
  isEnterDatabaseOperationModeCommand,
  isExitDatabaseOperationModeCommand,
  isExportCancellation,
  isExportConfirmation,
  normalizeExportIntentText,
} from "./export-intent-router";

describe("export-intent-router", () => {
  it("normalizes IM sender prefixes before forwarding to export lane", () => {
    expect(normalizeExportIntentText("[IM:海超] 帮我查一下王者荣耀")).toBe("帮我查一下王者荣耀");
    expect(normalizeExportIntentText("  [IM:海超]   目前有哪些库可以查  ")).toBe("目前有哪些库可以查");
  });

  it("recognizes explicit database mode enter and exit commands", () => {
    expect(isEnterDatabaseOperationModeCommand("数据库操作")).toBe(true);
    expect(isEnterDatabaseOperationModeCommand("[IM:海超] 数据库操作")).toBe(true);
    expect(isEnterDatabaseOperationModeCommand("帮我数据库操作一下")).toBe(false);

    expect(isExitDatabaseOperationModeCommand("退出数据库操作")).toBe(true);
    expect(isExitDatabaseOperationModeCommand("[IM:海超] 退出数据库操作")).toBe(true);
    expect(isExitDatabaseOperationModeCommand("退出数据库操作模式")).toBe(false);
  });

  it("keeps export confirmation and cancellation compatibility", () => {
    expect(isExportConfirmation("确认导出")).toBe(true);
    expect(isExportConfirmation("[IM:海超] 可以")).toBe(true);
    expect(isExportCancellation("取消导出")).toBe(true);
    expect(isExportCancellation("[IM:海超] 不用了")).toBe(true);
  });
});
