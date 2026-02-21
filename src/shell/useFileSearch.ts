/**
 * 文件搜索 Hook — 异步 + 300ms 防抖
 * 从 App.tsx 提取的文件搜索逻辑
 */

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError, ErrorLevel } from "@/core/errors";

export interface FileSearchResult {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  file_type: string;
}

/**
 * 文件搜索（f 前缀或通用搜索），带 300ms 防抖
 */
export function useFileSearch(searchValue: string): FileSearchResult[] {
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
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

    // 前缀模式不搜索文件
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
      isAppPrefix ||
      (isPrefix && !isFilePrefix)
    ) {
      queueMicrotask(() => {
        setFileResults([]);
      });
      return;
    }

    timerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<FileSearchResult[]>("file_search", {
          query,
          maxResults: isFilePrefix ? 24 : 8,
        });
        setFileResults(results);
      } catch (e) {
        handleError(e, { context: "文件搜索", level: ErrorLevel.Warning });
        setFileResults([]);
      }
    }, 300);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [searchValue]);

  return fileResults;
}
