import { useAIStore } from "@/store/ai-store";
import { loadAgentExecutionPolicy } from "./policy";
import { ContainerRuntimeAdapter } from "./container-runtime-adapter";
import { HostRuntimeAdapter } from "./host-runtime-adapter";
import type {
  AgentExecutionPolicy,
  ContainerRuntimeAvailability,
  RuntimeActionName,
  RuntimeAdapter,
  RuntimeExecuteOptions,
} from "./types";

function normalizePath(input: string) {
  return input
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isPathAllowed(path: string, allowedRoots: string[]) {
  if (allowedRoots.length === 0) return true;
  const target = normalizePath(path);
  return allowedRoots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
  });
}

export class AgentRuntimeManager {
  private readonly hostAdapter = new HostRuntimeAdapter();

  private readonly containerAdapter = new ContainerRuntimeAdapter();

  private async resolveAdapter(
    action: RuntimeActionName,
    policy: AgentExecutionPolicy,
    options: RuntimeExecuteOptions,
    context: { command?: string; path?: string },
  ): Promise<RuntimeAdapter> {
    const mode = useAIStore.getState().config.agent_runtime_mode || "host";

    if (mode === "host") {
      return this.hostAdapter;
    }

    const containerAvailability = await this.containerAdapter.getAvailability?.();
    const containerAvailable = containerAvailability?.available ?? false;
    const hasAllowedRoots = policy.allowed_roots.length > 0;

    if (mode === "hybrid") {
      if (containerAvailable && hasAllowedRoots) {
        return this.containerAdapter;
      }
      return this.hostAdapter;
    }

    if (containerAvailable && hasAllowedRoots) {
      return this.containerAdapter;
    }

    const reason =
      containerAvailable && !hasAllowedRoots
        ? "容器运行时需要配置 allowed_roots，当前策略为空"
        : containerAvailability?.message || "容器运行时不可用";

    if (
      options.allowUnattendedHostFallback &&
      policy.allow_unattended_host_fallback
    ) {
      return this.hostAdapter;
    }

    if (!options.confirmHostFallback) {
      if (options.allowUnattendedHostFallback) {
        throw new Error(`${reason}，且策略未允许无人值守降级到宿主机`);
      }
      throw new Error(`${reason}，缺少宿主机降级确认`);
    }

    const confirmed = await options.confirmHostFallback({
      action,
      mode,
      reason,
      ...context,
    });
    if (!confirmed) {
      throw new Error("用户拒绝宿主机降级执行");
    }

    return this.hostAdapter;
  }

  async getContainerAvailability(): Promise<ContainerRuntimeAvailability> {
    return (
      (await this.containerAdapter.getAvailability?.()) || {
        available: false,
        runtime: "docker",
        message: "容器运行时状态未知",
      }
    );
  }

  async runShellCommand(command: string, options: RuntimeExecuteOptions = {}) {
    const policy = await loadAgentExecutionPolicy();
    if (policy.block_mode) {
      throw new Error("Agent 策略阻断模式已开启，禁止执行命令");
    }
    if (policy.force_readonly) {
      throw new Error("Agent 只读策略已开启，禁止执行命令");
    }

    const adapter = await this.resolveAdapter("run_shell_command", policy, options, {
      command,
    });
    return adapter.runShellCommand(command, {
      allowedRoots: policy.allowed_roots,
    });
  }

  async writeTextFile(
    path: string,
    content: string,
    options: RuntimeExecuteOptions = {},
  ) {
    const policy = await loadAgentExecutionPolicy();
    if (policy.block_mode) {
      throw new Error("Agent 策略阻断模式已开启，禁止写文件");
    }
    if (policy.force_readonly) {
      throw new Error("Agent 只读策略已开启，禁止写文件");
    }
    if (!isPathAllowed(path, policy.allowed_roots)) {
      throw new Error("Agent 策略禁止写入该路径（不在 allowed_roots）");
    }

    const adapter = await this.resolveAdapter("write_file", policy, options, {
      path,
    });
    return adapter.writeTextFile(path, content, {
      allowedRoots: policy.allowed_roots,
    });
  }
}

export const agentRuntimeManager = new AgentRuntimeManager();
