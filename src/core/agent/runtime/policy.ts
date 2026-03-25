import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { handleError, ErrorLevel } from "@/core/errors";
import {
  DEFAULT_AGENT_EXECUTION_POLICY,
  type AgentExecutionPolicy,
} from "./types";

const POLICY_CACHE_TTL_MS = 10_000;

let cachedPolicy: AgentExecutionPolicy = DEFAULT_AGENT_EXECUTION_POLICY;
let cachedAt = 0;

function normalizePolicy(raw: unknown): AgentExecutionPolicy {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_AGENT_EXECUTION_POLICY;
  }

  const src = raw as Record<string, unknown>;
  const allowedRoots = Array.isArray(src.allowed_roots)
    ? src.allowed_roots
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .map((v) => v.trim())
    : [];

  return {
    allowed_roots: allowedRoots,
    force_readonly: Boolean(src.force_readonly),
    block_mode: Boolean(src.block_mode),
    allow_unattended_host_fallback: Boolean(src.allow_unattended_host_fallback),
  };
}

async function resolvePolicyPath() {
  const home = await homeDir();
  return join(home, ".config", "HiClow", "agent-policy.json");
}

export async function loadAgentExecutionPolicy(force = false) {
  const now = Date.now();
  if (!force && now - cachedAt <= POLICY_CACHE_TTL_MS) {
    return cachedPolicy;
  }

  try {
    const path = await resolvePolicyPath();
    const content = await invoke<string>("read_text_file", { path });
    const parsed = JSON.parse(content);
    cachedPolicy = normalizePolicy(parsed);
    cachedAt = now;
    return cachedPolicy;
  } catch (e) {
    // 缺失策略文件视为默认策略，避免每次都报错打扰用户
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes("文件不存在")) {
      handleError(e, {
        context: "读取 Agent 外部策略",
        level: ErrorLevel.Warning,
        silent: true,
      });
    }
    cachedPolicy = DEFAULT_AGENT_EXECUTION_POLICY;
    cachedAt = now;
    return cachedPolicy;
  }
}
