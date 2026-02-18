/**
 * 应用搜索 Hook — 异步 + 200ms 防抖
 * 从 App.tsx 提取的本地应用搜索逻辑
 */

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError, ErrorLevel } from "@/core/errors";

export interface AppSearchResult {
  name: string;
  path: string;
}

/**
 * 本地应用搜索（app 前缀或通用搜索），带 200ms 防抖
 */
export function useAppSearch(searchValue: string): AppSearchResult[] {
  const [appResults, setAppResults] = useState<AppSearchResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const trimmed = searchValue.trim();
    const isFilePrefix = trimmed.startsWith("f ");
    const isAppPrefix = trimmed.startsWith("app ");
    const query = isFilePrefix
      ? trimmed.slice(2).trim()
      : isAppPrefix
        ? trimmed.slice(4).trim()
        : trimmed;

    // 前缀模式不搜索应用
    const prefixModes = [
      "ai ",
      "bd ",
      "gg ",
      "bing ",
      "/ ",
      "cb",
      "data ",
      "sn ",
      "bk ",
    ];
    const isPrefix = prefixModes.some(
      (p) => trimmed.startsWith(p) || trimmed === p.trim(),
    );

    if (
      !query ||
      query.length < 2 ||
      isFilePrefix ||
      (isPrefix && !isAppPrefix)
    ) {
      setAppResults([]);
      return;
    }

    timerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<AppSearchResult[]>("app_search", {
          query,
          maxResults: isAppPrefix ? 20 : 5,
        });
        setAppResults(results);
      } catch (e) {
        handleError(e, { context: "应用搜索", level: ErrorLevel.Warning });
        setAppResults([]);
      }
    }, 200);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [searchValue]);

  return appResults;
}
