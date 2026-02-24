import type { AgentRuntimeMode } from "@/core/ai/types";

export interface AgentExecutionPolicy {
  allowed_roots: string[];
  force_readonly: boolean;
  block_mode: boolean;
  allow_unattended_host_fallback: boolean;
}

export const DEFAULT_AGENT_EXECUTION_POLICY: AgentExecutionPolicy = {
  allowed_roots: [],
  force_readonly: false,
  block_mode: false,
  allow_unattended_host_fallback: false,
};

export type RuntimeActionName = "run_shell_command" | "write_file";

export interface RuntimeFallbackContext {
  action: RuntimeActionName;
  mode: AgentRuntimeMode;
  command?: string;
  path?: string;
  reason?: string;
}

export type ConfirmHostFallback = (
  context: RuntimeFallbackContext,
) => Promise<boolean>;

export interface RuntimeExecuteOptions {
  confirmHostFallback?: ConfirmHostFallback;
  allowUnattendedHostFallback?: boolean;
  /**
   * 仅交互式场景生效：
   * 当外部策略未配置 allowed_roots 时，允许在用户确认后降级宿主机默认权限写入。
   * 后台任务请保持 false，避免无人值守突破策略边界。
   */
  allowInteractiveHostWriteWhenNoPolicyRoots?: boolean;
}

export interface RuntimeExecutionContext {
  allowedRoots?: string[];
}

export interface ContainerRuntimeAvailability {
  available: boolean;
  runtime: "docker";
  message: string;
}

export interface RuntimeShellResult {
  runtime: "host" | "container";
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeWriteResult {
  runtime: "host" | "container";
  path: string;
  bytes: number;
  message: string;
}

export interface RuntimeAdapter {
  readonly name: "host" | "container";
  getAvailability?: () => Promise<ContainerRuntimeAvailability>;
  isAvailable: () => Promise<boolean>;
  runShellCommand: (
    command: string,
    context?: RuntimeExecutionContext,
  ) => Promise<RuntimeShellResult>;
  writeTextFile: (
    path: string,
    content: string,
    context?: RuntimeExecutionContext,
  ) => Promise<RuntimeWriteResult>;
}
