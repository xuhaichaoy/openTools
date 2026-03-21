import React, { useEffect, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FileDown,
  Loader2,
  Settings2,
  type LucideIcon,
} from "lucide-react";

import {
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
} from "@/core/agent/coding-profile";
import { getSpawnedTaskRoleBoundaryMeta } from "@/core/agent/actor/spawned-task-role-boundary";
import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import {
  decodePartialToolContent,
  formatArtifactPreviewBody,
  hasArtifactPayloadKey,
  parsePartialToolJSON,
  recoverArtifactBodyFromRaw,
} from "@/plugins/builtin/SmartAgent/core/tool-streaming-preview";

type StreamingTone = {
  bg: string;
  text: string;
  border: string;
  dot: string;
};

export type ToolStreamingPreview = {
  kind: "artifact" | "generic" | "thinking" | "spawn";
  title: string;
  body: string;
  fullBody?: string;
  meta?: string;
  collapsible?: boolean;
};

function basename(path: unknown): string {
  const s = String(path ?? "");
  return s.split("/").pop() || s;
}

function buildSequentialThinkingPreview(parsed: ReturnType<typeof parsePartialToolJSON>): ToolStreamingPreview {
  const thoughtText = decodePartialToolContent(parsed.thought || "");
  const thoughtMeta = [
    typeof parsed.thoughtNumber === "number" ? `步骤 ${parsed.thoughtNumber}` : "",
    typeof parsed.totalThoughts === "number" ? `共 ${parsed.totalThoughts} 步` : "",
  ].filter(Boolean).join(" · ");

  return {
    kind: "thinking",
    title: "深度思考",
    body: thoughtText || "正在组织思路...",
    meta: thoughtMeta || "顺序推理中",
  };
}

function buildSpawnTaskPreview(parsed: ReturnType<typeof parsePartialToolJSON>): ToolStreamingPreview {
  const taskText = decodePartialToolContent(parsed.task || "");
  const target = parsed.targetAgent || "未知 Agent";
  const roleBoundaryMeta = getSpawnedTaskRoleBoundaryMeta(parsed.roleBoundary as SpawnedTaskRecord["roleBoundary"]);
  const codingLabel = describeCodingExecutionProfile(
    inferCodingExecutionProfile({ query: `${parsed.label}\n${taskText}` }).profile,
  );
  const title = codingLabel
    ? `派发 ${codingLabel}${parsed.roleBoundary ? ` · ${roleBoundaryMeta.label}` : ""} 子任务 -> ${target}`
    : `派发${parsed.roleBoundary ? `${roleBoundaryMeta.label}` : ""}子任务 -> ${target}`;
  const meta = [
    parsed.label ? `标签: ${parsed.label}` : "",
    codingLabel ? `模式: ${codingLabel}` : "",
    parsed.roleBoundary ? `职责: ${roleBoundaryMeta.label}` : "",
  ].filter(Boolean).join(" · ");

  return {
    kind: "spawn",
    title,
    body: taskText || "正在整理委派任务...",
    meta: meta || "协作派发中",
  };
}

function inferStreamingArtifactLanguage(path: string): string | undefined {
  const fileName = basename(path).toLowerCase();
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  switch (ext) {
    case "html":
    case "htm":
      return "HTML";
    case "tsx":
    case "ts":
      return "TypeScript";
    case "jsx":
    case "js":
      return "JavaScript";
    case "css":
    case "scss":
    case "less":
      return "CSS";
    case "json":
      return "JSON";
    case "md":
      return "Markdown";
    case "py":
      return "Python";
    case "rs":
      return "Rust";
    case "sh":
    case "bash":
    case "zsh":
      return "Shell";
    default:
      return ext ? ext.toUpperCase() : undefined;
  }
}

function shouldRevealStreamingArtifactBody(path: string, body: string, formattedBody: string): boolean {
  const normalized = body.trim();
  if (!normalized) return false;
  if (normalized.includes("\n")) return true;
  if (formattedBody.includes("\n")) return true;
  if (normalized.length >= 72) return true;

  const ext = basename(path).toLowerCase().split(".").pop() || "";
  const codeLikePattern = /<!doctype html>|<html\b|<head\b|<body\b|<div\b|<main\b|<section\b|function\b|const\b|let\b|var\b|class\b|import\b|export\b|body\s*\{|@media\b/i;
  if (["html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "json", "md"].includes(ext)) {
    return normalized.length >= 24 || codeLikePattern.test(normalized);
  }

  return codeLikePattern.test(normalized);
}

function buildStreamingArtifactPreview(path: string, body: string): {
  meta: string;
  previewBody: string;
  fullBody: string;
  truncated: boolean;
} {
  const normalized = formatArtifactPreviewBody(path, body);
  const lines = normalized ? normalized.split("\n") : [];
  const maxLines = 18;
  const maxChars = 1200;
  const previewByLines = lines.slice(0, maxLines).join("\n");
  const previewBase = previewByLines.length > maxChars
    ? `${previewByLines.slice(0, maxChars)}...`
    : previewByLines;
  const truncated = normalized.length > previewBase.length || lines.length > maxLines;
  const previewBody = truncated ? `${previewBase}\n...` : previewBase;
  const language = inferStreamingArtifactLanguage(path);
  const metaParts = [
    language,
    lines.length > 0 ? `${lines.length} 行` : "",
    normalized.length > 0 ? `${normalized.length} 字符` : "",
  ].filter(Boolean);

  return {
    meta: metaParts.join(" · "),
    previewBody,
    fullBody: normalized,
    truncated,
  };
}

export function buildToolStreamingPreview(jsonStr: string): ToolStreamingPreview {
  const parsed = parsePartialToolJSON(jsonStr);
  const raw = decodePartialToolContent(jsonStr);
  const looksLikeArtifact = Boolean(
    parsed.path
      && (
        parsed.content
        || hasArtifactPayloadKey(jsonStr)
      ),
  );

  if (parsed.thought.trim()) {
    return buildSequentialThinkingPreview(parsed);
  }

  if (parsed.targetAgent.trim() && parsed.task.trim()) {
    return buildSpawnTaskPreview(parsed);
  }

  if (looksLikeArtifact) {
    const artifactBody = decodePartialToolContent(parsed.content || "")
      || recoverArtifactBodyFromRaw(jsonStr, parsed.path);
    const preview = buildStreamingArtifactPreview(parsed.path || "未知文件", artifactBody);
    return {
      kind: "artifact",
      title: `生成文件: ${parsed.path || "未知文件"}`,
      body: preview.previewBody,
      fullBody: preview.fullBody,
      meta: preview.meta,
      collapsible: preview.truncated,
    };
  }

  if (parsed.query) {
    return {
      kind: "generic",
      title: `准备搜索: ${parsed.query.slice(0, 48)}`,
      body: raw,
    };
  }
  if (parsed.url) {
    return {
      kind: "generic",
      title: `准备访问: ${parsed.url.replace(/^https?:\/\//, "").slice(0, 56)}`,
      body: raw,
    };
  }
  if (parsed.command) {
    return {
      kind: "generic",
      title: "准备执行命令",
      body: raw,
    };
  }
  if (parsed.path) {
    return {
      kind: "generic",
      title: `准备处理: ${basename(parsed.path)}`,
      body: raw,
    };
  }

  return {
    kind: "generic",
    title: "准备调用工具",
    body: raw,
  };
}

export function ThinkingBlock({
  roleName,
  content,
  startedAt,
  isStreaming,
  color,
}: {
  roleName: string;
  content: string;
  startedAt: number;
  isStreaming: boolean;
  color: StreamingTone;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  useEffect(() => {
    if (expanded && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [expanded, content]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`
    : `${elapsed}秒`;
  const displayContent = content.trim() || "模型正在深度思考，暂未返回可展示内容。";

  return (
    <div className={`flex gap-2 ${color.text}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
        <Brain className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[88%] min-w-[200px] lg:max-w-[78%]">
        <div className="text-[10px] mb-0.5">{roleName}</div>
        <div className={`rounded-xl ${color.bg} overflow-hidden`}>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] cursor-pointer hover:opacity-80 transition-opacity"
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 shrink-0" />
              : <ChevronRight className="w-3 h-3 shrink-0" />
            }
            <span className="opacity-70">
              深度思考{isStreaming ? "中" : "完成"}
            </span>
            <span className="opacity-50 ml-auto tabular-nums">
              {isStreaming && <Loader2 className="w-3 h-3 animate-spin inline mr-1" />}
              {timeLabel}
            </span>
          </button>
          {expanded && (
            <div
              ref={containerRef}
              className="px-3 pb-2 text-[12px] leading-relaxed opacity-70 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border-t border-current/5"
            >
              {displayContent}
              {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LiveExecutionCard({
  roleName,
  title,
  detail,
  startedAt,
  isStreaming,
  color,
  icon: Icon = Settings2,
}: {
  roleName: string;
  title: string;
  detail?: string;
  startedAt: number;
  isStreaming: boolean;
  color: StreamingTone;
  icon?: LucideIcon;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`;

  return (
    <div className={`flex gap-2 ${color.text}`}>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${color.bg}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[88%] min-w-[220px] lg:max-w-[78%]">
        <div className="mb-0.5 text-[10px]">{roleName}</div>
        <div className={`rounded-xl border border-current/10 ${color.bg} px-3 py-2`}>
          <div className="flex items-center gap-2 text-[12px]">
            {isStreaming && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-70" />}
            <span className="font-medium">{title}</span>
            <span className="ml-auto text-[10px] opacity-50 tabular-nums">{timeLabel}</span>
          </div>
          {detail && (
            <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed opacity-75">
              {detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ToolStreamingBlock({
  roleName,
  content,
  startedAt,
  isStreaming,
  color,
}: {
  roleName: string;
  content: string;
  startedAt: number;
  isStreaming: boolean;
  color: StreamingTone;
}) {
  const [now, setNow] = useState(Date.now());
  const containerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`;
  const parsed = parsePartialToolJSON(content);
  const artifactPath = parsed.path || "未知文件";
  const rawArtifactBody = decodePartialToolContent(parsed.content || "")
    || recoverArtifactBodyFromRaw(content, artifactPath);
  const normalizedArtifactBody = rawArtifactBody
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const formattedArtifactBody = normalizedArtifactBody
    ? formatArtifactPreviewBody(artifactPath, normalizedArtifactBody)
    : "";
  const streamingArtifactBody = shouldRevealStreamingArtifactBody(
    artifactPath,
    normalizedArtifactBody,
    formattedArtifactBody,
  )
    ? (formattedArtifactBody || normalizedArtifactBody)
    : "";
  const displayedBody = isStreaming
    ? streamingArtifactBody
    : (formattedArtifactBody || normalizedArtifactBody);
  const isBufferingPreview = !displayedBody;

  return (
    <div className={`flex gap-2 ${color.text} mt-2`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
        <FileDown className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[90%] min-w-[250px] flex-1">
        <div className="text-[10px] mb-0.5">{roleName}</div>
        <div className="rounded-xl border border-current/10 bg-[var(--color-bg)] overflow-hidden shadow-sm">
          <div className={`flex items-center gap-2 px-3 py-2 text-[11px] border-b border-current/10 ${color.bg}`}>
            <span className="font-medium opacity-90 truncate max-w-[70%]">
              生成文件: {artifactPath}
            </span>
            <span className="opacity-50 ml-auto tabular-nums flex items-center gap-1">
              {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
              {timeLabel}
            </span>
          </div>
          <pre
            ref={containerRef}
            className="max-h-[350px] overflow-auto whitespace-pre bg-[#1e1e1e] p-3 font-mono text-[12px] leading-[1.6] text-[#d4d4d4]"
          >
            {displayedBody || (
              <span className="opacity-30">{isBufferingPreview ? "正在整理代码内容..." : "准备写入中..."}</span>
            )}
            {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
          </pre>
        </div>
      </div>
    </div>
  );
}
