/**
 * 窗口尺寸管理逻辑
 * 从 App.tsx 提取的窗口动态调整逻辑
 */

import { invoke } from "@tauri-apps/api/core";
import {
  WINDOW_HEIGHT_COLLAPSED,
  WINDOW_HEIGHT_EXPANDED,
  WINDOW_HEIGHT_CHAT,
} from "@/core/constants";
import type { ResultItem } from "@/components/search/ResultList";

const BASE_HEIGHT = 80;
const GRID_COLS = 8;
const ROW_HEIGHT = 110;

/**
 * 根据当前视图和搜索状态调整窗口大小
 */
export function updateWindowSize(
  view: string,
  searchValue: string,
  getFilteredResults: () => ResultItem[],
  setWindowExpanded: (expanded: boolean) => void,
) {
  if (view === "main") {
    if (!searchValue) {
      invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
      setWindowExpanded(true);
    } else {
      const results = getFilteredResults();
      if (results.length > 0) {
        const rows = Math.ceil(results.length / GRID_COLS);
        const contentHeight = rows * ROW_HEIGHT;
        const height = Math.min(
          BASE_HEIGHT + contentHeight + 16,
          WINDOW_HEIGHT_EXPANDED,
        );
        invoke("resize_window", { height });
        setWindowExpanded(true);
      } else {
        invoke("resize_window", { height: WINDOW_HEIGHT_COLLAPSED });
        setWindowExpanded(false);
      }
    }
  } else if (view === "ai-center") {
    invoke("resize_window", { height: WINDOW_HEIGHT_CHAT });
    setWindowExpanded(true);
  } else {
    invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
    setWindowExpanded(true);
  }
}
