import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionPolicy } from "./types";

const invokeMock = vi.fn();
const loadPolicyMock = vi.fn<() => Promise<AgentExecutionPolicy>>();

const aiState = {
  config: {
    agent_runtime_mode: "host" as "host" | "hybrid" | "container_preferred",
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => aiState,
  },
}));

vi.mock("./policy", () => ({
  loadAgentExecutionPolicy: () => loadPolicyMock(),
}));

import { AgentRuntimeManager } from "./runtime-manager";

describe("AgentRuntimeManager", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_container_available") {
        return Promise.resolve({
          available: false,
          runtime: "docker",
          message: "Docker 不可用",
        });
      }
      return Promise.resolve({
        runtime: "host",
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    });
    loadPolicyMock.mockReset();
    aiState.config.agent_runtime_mode = "host";
    loadPolicyMock.mockResolvedValue({
      allowed_roots: [],
      force_readonly: false,
      block_mode: false,
      allow_unattended_host_fallback: false,
    });
  });

  it("should execute command with host runtime by default", async () => {
    const manager = new AgentRuntimeManager();

    const result = await manager.runShellCommand("echo hi");

    expect(result).toMatchObject({
      runtime: "host",
      exit_code: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("run_shell_command", {
      command: "echo hi",
    });
  });

  it("should fallback to host in hybrid mode when container unavailable", async () => {
    aiState.config.agent_runtime_mode = "hybrid";
    const manager = new AgentRuntimeManager();

    const result = await manager.runShellCommand("echo hybrid");

    expect(result).toMatchObject({
      runtime: "host",
      exit_code: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("run_shell_command", {
      command: "echo hybrid",
    });
    expect(invokeMock).toHaveBeenCalledWith("agent_container_available");
  });

  it("should use container runtime in hybrid mode when available", async () => {
    aiState.config.agent_runtime_mode = "hybrid";
    loadPolicyMock.mockResolvedValue({
      allowed_roots: ["/Users/haichao/workspace/safe"],
      force_readonly: false,
      block_mode: false,
      allow_unattended_host_fallback: false,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_container_available") {
        return Promise.resolve({
          available: true,
          runtime: "docker",
          message: "Docker 可用",
        });
      }
      if (command === "agent_container_run_shell") {
        return Promise.resolve({
          runtime: "container",
          exit_code: 0,
          stdout: "ok",
          stderr: "",
        });
      }
      return Promise.resolve({
        runtime: "host",
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    });
    const manager = new AgentRuntimeManager();

    const result = await manager.runShellCommand("echo hybrid-container");

    expect(result).toMatchObject({
      runtime: "container",
      exit_code: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("agent_container_run_shell", {
      command: "echo hybrid-container",
      allowedRoots: ["/Users/haichao/workspace/safe"],
    });
  });

  it("should require fallback confirmation when container is unavailable", async () => {
    aiState.config.agent_runtime_mode = "container_preferred";
    const manager = new AgentRuntimeManager();

    await expect(
      manager.runShellCommand("echo denied", {
        confirmHostFallback: async () => false,
      }),
    ).rejects.toThrow("用户拒绝宿主机降级执行");

    expect(invokeMock).toHaveBeenCalledWith("agent_container_available");
  });

  it("should fallback to host when container is available but allowed_roots is empty", async () => {
    aiState.config.agent_runtime_mode = "container_preferred";
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_container_available") {
        return Promise.resolve({
          available: true,
          runtime: "docker",
          message: "Docker 可用",
        });
      }
      return Promise.resolve({
        runtime: "host",
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    });
    const manager = new AgentRuntimeManager();
    let fallbackReason = "";

    const result = await manager.runShellCommand("echo fallback", {
      confirmHostFallback: async (context) => {
        fallbackReason = context.reason || "";
        return true;
      },
    });

    expect(result).toMatchObject({
      runtime: "host",
      exit_code: 0,
    });
    expect(fallbackReason).toContain("allowed_roots");
    expect(invokeMock).toHaveBeenCalledWith("run_shell_command", {
      command: "echo fallback",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent_container_run_shell",
      expect.anything(),
    );
  });

  it("should use container runtime when available and allowed_roots exists", async () => {
    aiState.config.agent_runtime_mode = "container_preferred";
    loadPolicyMock.mockResolvedValue({
      allowed_roots: ["/Users/haichao/workspace/safe"],
      force_readonly: false,
      block_mode: false,
      allow_unattended_host_fallback: false,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_container_available") {
        return Promise.resolve({
          available: true,
          runtime: "docker",
          message: "Docker 可用",
        });
      }
      if (command === "agent_container_run_shell") {
        return Promise.resolve({
          runtime: "container",
          exit_code: 0,
          stdout: "",
          stderr: "",
        });
      }
      return Promise.resolve({
        runtime: "host",
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    });
    const manager = new AgentRuntimeManager();

    const result = await manager.runShellCommand("echo container");

    expect(result).toMatchObject({
      runtime: "container",
      exit_code: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("agent_container_run_shell", {
      command: "echo container",
      allowedRoots: ["/Users/haichao/workspace/safe"],
    });
    expect(invokeMock).not.toHaveBeenCalledWith("run_shell_command", {
      command: "echo container",
    });
  });

  it("should block write outside allowed_roots", async () => {
    loadPolicyMock.mockResolvedValue({
      allowed_roots: ["/Users/haichao/workspace/safe"],
      force_readonly: false,
      block_mode: false,
      allow_unattended_host_fallback: false,
    });
    const manager = new AgentRuntimeManager();

    await expect(
      manager.writeTextFile("/etc/passwd", "demo"),
    ).rejects.toThrow("allowed_roots");

    expect(invokeMock).not.toHaveBeenCalledWith("run_shell_command", expect.anything());
  });

  it("should deny unattended host fallback when policy is not enabled", async () => {
    aiState.config.agent_runtime_mode = "container_preferred";
    const manager = new AgentRuntimeManager();

    await expect(
      manager.runShellCommand("echo deny", {
        allowUnattendedHostFallback: true,
      }),
    ).rejects.toThrow("策略未允许无人值守降级");

    expect(invokeMock).toHaveBeenCalledWith("agent_container_available");
  });

  it("should allow unattended host fallback when policy is enabled", async () => {
    aiState.config.agent_runtime_mode = "container_preferred";
    loadPolicyMock.mockResolvedValue({
      allowed_roots: [],
      force_readonly: false,
      block_mode: false,
      allow_unattended_host_fallback: true,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "agent_container_available") {
        return Promise.resolve({
          available: false,
          runtime: "docker",
          message: "Docker 不可用",
        });
      }
      return Promise.resolve({
        runtime: "host",
        exit_code: 0,
        stdout: "",
        stderr: "",
      });
    });
    const manager = new AgentRuntimeManager();

    const result = await manager.runShellCommand("echo allow", {
      allowUnattendedHostFallback: true,
    });

    expect(result).toMatchObject({
      runtime: "host",
      exit_code: 0,
    });
    expect(invokeMock).toHaveBeenCalledWith("run_shell_command", {
      command: "echo allow",
    });
  });
});
