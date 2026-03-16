/**
 * 窗口尺寸管理逻辑
 * 从 App.tsx 提取的窗口动态调整逻辑
 */

import { invoke } from "@tauri-apps/api/core";
import {
  WINDOW_HEIGHT_COLLAPSED,
} from "@/core/constants";
import type { ResultItem } from "@/components/search/ResultList";
import { getPreferredWindowHeight } from "@/core/ui/local-ui-preferences";

const BASE_HEIGHT = 80;
const GRID_COLS = 8;
const ROW_HEIGHT = 110;

export async function resizeManagedWindowHeight(height: number): Promise<void> {
  await invoke("resize_window", { height });
}

/**
 * 根据当前视图和搜索状态调整窗口大小
 */
export function updateWindowSize(
  view: string,
  searchValue: string,
  getFilteredResults: () => ResultItem[],
  setWindowExpanded: (expanded: boolean) => void,
) {
  const expandedHeight = getPreferredWindowHeight("expanded");
  const chatHeight = getPreferredWindowHeight("chat");

  if (view === "main") {
    if (!searchValue) {
      void resizeManagedWindowHeight(expandedHeight);
      setWindowExpanded(true);
    } else {
      const results = getFilteredResults();
      if (results.length > 0) {
        const rows = Math.ceil(results.length / GRID_COLS);
        const contentHeight = rows * ROW_HEIGHT;
        const height = Math.min(
          BASE_HEIGHT + contentHeight + 16,
          expandedHeight,
        );
        void resizeManagedWindowHeight(height);
        setWindowExpanded(true);
      } else {
        void resizeManagedWindowHeight(WINDOW_HEIGHT_COLLAPSED);
        setWindowExpanded(false);
      }
    }
  } else if (view === "ai-center") {
    void resizeManagedWindowHeight(chatHeight);
    setWindowExpanded(true);
  } else {
    void resizeManagedWindowHeight(expandedHeight);
    setWindowExpanded(true);
  }
}
