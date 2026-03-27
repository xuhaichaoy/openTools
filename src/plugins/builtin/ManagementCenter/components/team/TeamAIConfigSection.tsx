import { useEffect, useState } from "react";
import { Cpu, Loader2, Settings, Trash2 } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import {
  DEFAULT_CLAWHUB_SITE_URL,
} from "@/core/agent/skills/clawhub-config";
import {
  getTeamClawHubConfig,
  getTeamClawHubStatus,
  saveTeamClawHubConfig,
  verifyTeamClawHubConfig,
  type TeamClawHubConfig,
  type TeamClawHubStatus,
} from "@/core/agent/skills/clawhub-team-api";
import { EmbeddingConfigSection } from "../AIModelTabSections";
import { TeamQuotaSection } from "./TeamQuotaSection";
import type { TeamMember } from "./TeamMembersSection";

interface AiConfigItem {
  id?: string;
  config_id?: string;
  config_name?: string;
  display_name?: string;
  model_name: string | null;
  protocol: string;
  base_url?: string;
  priority?: number;
  is_active?: boolean;
  masked_key?: string;
}

function createDefaultClawHubForm() {
  return {
    id: undefined as string | undefined,
    token: "",
    is_active: true,
  };
}

export function TeamAIConfigSection({
  teamId,
  teamMembers,
  isOwnerOrAdmin,
  teamActive,
}: {
  teamId: string;
  teamMembers: TeamMember[];
  isOwnerOrAdmin: boolean;
  teamActive: boolean;
}) {
  const [configs, setConfigs] = useState<AiConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    id: undefined as string | undefined,
    config_name: "",
    model_name: "",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    priority: 1000,
  });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clawHubLoading, setClawHubLoading] = useState(true);
  const [clawHubSaving, setClawHubSaving] = useState(false);
  const [clawHubVerifying, setClawHubVerifying] = useState(false);
  const [clawHubConfig, setClawHubConfig] = useState<TeamClawHubConfig | null>(null);
  const [clawHubStatus, setClawHubStatus] = useState<TeamClawHubStatus | null>(null);
  const [clawHubForm, setClawHubForm] = useState(createDefaultClawHubForm);
  const [clawHubMessage, setClawHubMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  useEffect(() => {
    const fetchConfigs = async () => {
      if (!teamActive) {
        setConfigs([]);
        setLoading(false);
        return;
      }

      try {
        if (isOwnerOrAdmin) {
          const res = await api.get<{ configs: AiConfigItem[] }>(
            `/teams/${teamId}/ai-config`,
          );
          setConfigs(res.configs || []);
        } else {
          const res = await api.get<{ models: AiConfigItem[] }>(
            `/teams/${teamId}/ai-models`,
          );
          setConfigs(
            (res.models || []).map((item) => ({
              id: item.config_id || item.id,
              config_id: item.config_id || item.id,
              display_name: item.display_name,
              config_name: item.display_name,
              model_name: item.model_name,
              protocol: item.protocol,
              priority: item.priority,
              is_active: true,
            })),
          );
        }
      } catch (err) {
        handleError(err, { context: "获取团队 AI 配置" });
      } finally {
        setLoading(false);
      }
    };

    fetchConfigs();
  }, [teamId, isOwnerOrAdmin, teamActive]);

  useEffect(() => {
    const resetForm = (config: TeamClawHubConfig | null) => {
      setClawHubConfig(config);
      setClawHubForm({
        id: config?.id,
        token: "",
        is_active: config?.is_active !== false,
      });
    };

    const fetchClawHubConfig = async () => {
      if (!teamActive) {
        resetForm(null);
        setClawHubLoading(false);
        return;
      }

      setClawHubLoading(true);
      try {
        const config = await getTeamClawHubConfig(teamId);
        resetForm(config);
      } catch (err) {
        handleError(err, { context: "获取团队 ClawHub 配置" });
        resetForm(null);
      } finally {
        setClawHubLoading(false);
      }
    };

    void fetchClawHubConfig();
  }, [teamActive, teamId]);

  const reloadConfigs = async () => {
    if (!teamActive) return;
    const res = await api.get<{ configs: AiConfigItem[] }>(`/teams/${teamId}/ai-config`);
    setConfigs(res.configs || []);
  };

  const reloadClawHubConfig = async () => {
    if (!teamActive) return;
    const config = await getTeamClawHubConfig(teamId);
    setClawHubConfig(config);
    setClawHubForm({
      id: config?.id,
      token: "",
      is_active: config?.is_active !== false,
    });
  };

  const reloadClawHubStatus = async () => {
    if (!teamActive) return;
    const status = await getTeamClawHubStatus(teamId);
    setClawHubStatus(status);
  };

  useEffect(() => {
    const loadClawHubStatus = async () => {
      if (!teamActive) {
        setClawHubStatus(null);
        return;
      }
      try {
        await reloadClawHubStatus();
      } catch (err) {
        handleError(err, { context: "加载团队 ClawHub 状态" });
        setClawHubStatus(null);
      }
    };

    void loadClawHubStatus();
  }, [teamActive, teamId]);

  const handleSave = async () => {
    if (!teamActive) return;
    if (!form.api_key && !form.id) return;

    setSaving(true);
    try {
      await api.put(`/teams/${teamId}/ai-config`, {
        id: form.id,
        config_name: form.config_name || form.model_name || "未命名",
        model_name: form.model_name || null,
        protocol: form.protocol,
        base_url: form.base_url,
        api_key: form.api_key,
        priority: form.priority,
      });

      setForm({
        id: undefined,
        config_name: "",
        model_name: "",
        protocol: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "",
        priority: 1000,
      });

      await reloadConfigs();
    } catch (err) {
      handleError(err, { context: "保存团队 AI 配置" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (configId: string) => {
    if (!teamActive) return;
    if (deletingId === configId) {
      try {
        await api.delete(`/teams/${teamId}/ai-config/${configId}`);
        setConfigs(configs.filter((c) => c.id !== configId));
      } catch (err) {
        handleError(err, { context: "删除团队 AI 配置" });
      } finally {
        setDeletingId(null);
      }
    } else {
      setDeletingId(configId);
      setTimeout(() => {
        setDeletingId((prev) => (prev === configId ? null : prev));
      }, 3000);
    }
  };

  const handleToggleActive = async (configId: string, currentActive: boolean) => {
    if (!teamActive) return;
    try {
      await api.patch(`/teams/${teamId}/ai-config/${configId}`, {
        is_active: !currentActive,
      });
      setConfigs(
        configs.map((item) =>
          item.id === configId
            ? { ...item, is_active: !currentActive }
            : item,
        ),
      );
    } catch (err) {
      handleError(err, { context: "切换 AI 配置状态" });
    }
  };

  const handleEdit = (item: AiConfigItem) => {
    if (!teamActive) return;
    setForm({
      id: item.id,
      config_name: item.config_name || item.display_name || "",
      model_name: item.model_name || "",
      protocol: item.protocol,
      base_url: item.base_url || "https://api.openai.com/v1",
      api_key: "",
      priority: item.priority ?? 1000,
    });
  };

  const handleSaveClawHub = async () => {
    if (!teamActive || !isOwnerOrAdmin) return;

    setClawHubSaving(true);
    try {
      await saveTeamClawHubConfig({
        teamId,
        id: clawHubForm.id,
        token: clawHubForm.token,
        is_active: clawHubForm.is_active,
      });
      await reloadClawHubConfig();
      await reloadClawHubStatus();
      setClawHubMessage({ type: "success", text: "团队 ClawHub 配置已保存" });
    } catch (err) {
      handleError(err, { context: "保存团队 ClawHub 配置" });
      setClawHubMessage({ type: "error", text: "保存团队 ClawHub 配置失败" });
    } finally {
      setClawHubSaving(false);
    }
  };

  const handleVerifyClawHub = async () => {
    if (!teamActive || !isOwnerOrAdmin) return;

    setClawHubVerifying(true);
    try {
      const result = await verifyTeamClawHubConfig(teamId);
      await reloadClawHubStatus();
      setClawHubMessage({
        type: "success",
        text: result.stdout?.trim() || "团队 ClawHub 配置验证成功",
      });
    } catch (err) {
      handleError(err, { context: "验证团队 ClawHub 配置" });
      setClawHubMessage({ type: "error", text: "验证团队 ClawHub 配置失败" });
    } finally {
      setClawHubVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  if (!teamActive) {
    return (
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)]">
        <h3 className="text-xs font-semibold">团队 AI 模型配置</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
          团队已到期，团队 AI 配置与配额能力不可用，续费后恢复。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--space-compact-2)]">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
        <div>
          <h3 className="text-xs font-semibold">团队 AI 模型配置</h3>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {isOwnerOrAdmin
              ? "配置团队共享的 AI API Key，成员使用时无需消耗个人额度。"
              : "以下是团队可用的 AI 模型。"}
          </p>
        </div>

        {configs.length > 0 && (
          <div className="divide-y divide-[var(--color-border)]">
            {configs.map((item, index) => (
              <div
                key={item.id || item.config_id || index}
                className="flex items-center justify-between py-2"
              >
                <div className="flex items-center gap-2.5">
                  <Cpu className="w-3.5 h-3.5 text-[#F28F36]" />
                  <div>
                    <div className="text-xs font-medium">
                      {item.config_name || item.display_name || item.model_name || "未命名模型"}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {item.protocol} · {item.model_name || "全型号"}
                      {item.masked_key && (
                        <span className="ml-1.5 opacity-50">{item.masked_key}</span>
                      )}
                      {typeof item.priority === "number" &&
                        ` · 优先级 P${item.priority}（越小越优先）`}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isOwnerOrAdmin ? (
                    <button
                      onClick={() => item.id && handleToggleActive(item.id, !!item.is_active)}
                      className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
                      title={item.is_active ? "点击停用" : "点击启用"}
                      style={{
                        background: item.is_active
                          ? "#10b981"
                          : "var(--color-bg-secondary)",
                        border: item.is_active
                          ? "none"
                          : "1px solid var(--color-border)",
                      }}
                    >
                      <div
                        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                          item.is_active ? "translate-x-[15px]" : "translate-x-[2px]"
                        }`}
                      />
                    </button>
                  ) : (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full ${
                        item.is_active
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-gray-500/10 text-gray-500"
                      }`}
                    >
                      {item.is_active ? "已启用" : "已禁用"}
                    </span>
                  )}

                  {isOwnerOrAdmin && (
                    <>
                      <button
                        onClick={() => handleEdit(item)}
                        title="编辑"
                        className="p-1 text-[var(--color-text-secondary)] hover:text-[#F28F36] transition-colors"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => item.id && handleDelete(item.id)}
                        className={`p-1 transition-colors ${
                          deletingId === item.id
                            ? "text-red-500"
                            : "text-[var(--color-text-secondary)] hover:text-red-500"
                        }`}
                        title={deletingId === item.id ? "再次点击确认删除" : "删除"}
                        disabled={!item.id}
                      >
                        {deletingId === item.id ? (
                          <span className="text-xs font-medium">确认?</span>
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isOwnerOrAdmin && (
          <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
            <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              {form.id ? "编辑配置" : "添加新配置"}
            </h4>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={form.protocol}
                onChange={(e) => {
                  const protocol = e.target.value;
                  setForm({
                    ...form,
                    protocol,
                    base_url:
                      protocol === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com/v1",
                  });
                }}
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <input
                type="text"
                placeholder="限定模型名称 (如 claude-3-5-sonnet)"
                value={form.model_name}
                onChange={(e) =>
                  setForm({ ...form, model_name: e.target.value })
                }
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              />
            </div>

            <input
              type="url"
              placeholder="API Base URL (如 https://api.openai.com/v1)"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />

            <input
              type="password"
              placeholder={
                form.id
                  ? `留空不修改 (${configs.find((c) => c.id === form.id)?.masked_key || "****"})`
                  : "API Key"
              }
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />

            <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5">
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">
                优先级（越小越优先）
              </label>
              <input
                type="number"
                placeholder="数字越小越优先"
                value={form.priority}
                onChange={(e) =>
                  setForm({
                    ...form,
                    priority: Math.max(0, parseInt(e.target.value || "0", 10) || 0),
                  })
                }
                className="w-full bg-transparent text-xs outline-none"
              />
            </div>

            <p className="text-[10px] text-[var(--color-text-secondary)]">
              未指定 team_config_id 时，系统按优先级最小且启用的配置自动选择。
            </p>

            <button
              onClick={handleSave}
              disabled={!form.model_name || (!form.id && !form.api_key) || saving}
              className="w-full py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              保存配置
            </button>
          </div>
        )}
      </div>

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
        <div>
          <h3 className="text-xs font-semibold">ClawHub 技能中心</h3>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {isOwnerOrAdmin
              ? "可为整个团队配置共享的 ClawHub Token。成员显式提到 ClawHub 时，会优先走服务端代理搜索/安装，但安装结果仍落在成员本地。"
              : "团队如已配置共享 Token，你无需拿到明文 Token；成员显式提到 ClawHub 时会自动优先走团队代理。"}
          </p>
        </div>

        {clawHubLoading ? (
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            正在加载团队 ClawHub 配置...
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
              <div>
                <div className="text-xs font-medium">
                  {clawHubConfig?.is_active ? "已启用团队技能市场配置" : "团队技能市场配置未启用"}
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  {clawHubConfig?.masked_token
                    ? `当前已保存 Token：${clawHubConfig.masked_token}`
                    : "当前尚未保存团队 Token。"}
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  官方地址固定为 {DEFAULT_CLAWHUB_SITE_URL}/
                </div>
                {clawHubStatus && (
                  <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    {clawHubStatus.can_search
                      ? "服务端 ClawHub 代理可用"
                      : clawHubStatus.configured
                        ? "服务端暂不可代理搜索/安装，请检查共享 Token 与地址配置"
                        : "当前还未完成可用的团队技能市场配置"}
                  </div>
                )}
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full ${
                  clawHubConfig?.is_active
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "bg-gray-500/10 text-gray-500"
                }`}
              >
                {clawHubConfig?.is_active ? "已启用" : "未启用"}
              </span>
            </div>

            {isOwnerOrAdmin ? (
              <div className="space-y-2 pt-1">
                <input
                  type="password"
                  placeholder={
                    clawHubConfig?.masked_token
                      ? `留空则保留当前 Token (${clawHubConfig.masked_token})`
                      : "输入团队共享 ClawHub Token"
                  }
                  value={clawHubForm.token}
                  onChange={(e) =>
                    setClawHubForm((current) => ({
                      ...current,
                      token: e.target.value,
                    }))
                  }
                  className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
                />

                <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
                  <div>
                    <div className="text-xs font-medium">启用团队共享配置</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                      关闭后成员侧仍可使用个人 Token，但不会自动切到团队配置。
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setClawHubForm((current) => ({
                        ...current,
                        is_active: !current.is_active,
                      }))
                    }
                    className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
                    style={{
                      background: clawHubForm.is_active
                        ? "#10b981"
                        : "var(--color-bg)",
                      border: clawHubForm.is_active
                        ? "none"
                        : "1px solid var(--color-border)",
                    }}
                  >
                    <div
                      className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${
                        clawHubForm.is_active ? "translate-x-[15px]" : "translate-x-[2px]"
                      }`}
                    />
                  </button>
                </label>

                <button
                  onClick={handleSaveClawHub}
                  disabled={clawHubSaving}
                  className="w-full py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
                >
                  {clawHubSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                  保存团队 ClawHub 配置
                </button>

                <button
                  onClick={handleVerifyClawHub}
                  disabled={clawHubVerifying || !clawHubConfig?.is_active}
                  className="w-full py-1.5 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs font-semibold disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
                >
                  {clawHubVerifying && <Loader2 className="w-3 h-3 animate-spin" />}
                  验证团队 ClawHub 配置
                </button>

                {clawHubMessage && (
                  <div
                    className={`text-[10px] px-2 py-1 rounded ${
                      clawHubMessage.type === "error"
                        ? "bg-red-500/10 text-red-500"
                        : clawHubMessage.type === "success"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-blue-500/10 text-blue-500"
                    }`}
                  >
                    {clawHubMessage.text}
                  </div>
                )}

                <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                  <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                    团队共享 Token 说明
                  </div>

                  <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[10px] text-[var(--color-text-secondary)]">
                    团队 v1 只保留共享 Token 配置与验证。团队技能库、团队发布、团队实时搜索运营入口已退出主链路；
                    成员显式提到 ClawHub 时，会优先走团队代理搜索/安装，但安装结果仍落在成员本地。
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-[var(--color-text-secondary)]">
                你无需自行配置团队 Token；如需启用，请联系团队管理员在本页完成配置。
              </p>
            )}
          </>
        )}
      </div>

      {isOwnerOrAdmin && <TeamQuotaSection teamId={teamId} teamMembers={teamMembers} />}

      <EmbeddingConfigSection />
    </div>
  );
}
