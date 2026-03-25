import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import {
  DEFAULT_CLAWHUB_REGISTRY_URL,
  DEFAULT_CLAWHUB_SITE_URL,
  loadClawHubPersonalConfig,
  saveClawHubPersonalConfig,
  type ClawHubPersonalConfig,
} from "@/core/agent/skills/clawhub-config";
import {
  getTeamClawHubConfig,
  getTeamClawHubStatus,
  type TeamClawHubConfig,
  type TeamClawHubStatus,
} from "@/core/agent/skills/clawhub-team-api";
import { verifyClawHubToken } from "@/core/agent/skills/clawhub-tauri";
import {
  clawHubRuntimeService,
  type ClawHubRuntimeSkillCandidate,
} from "@/core/agent/skills/clawhub-runtime-service";
import { useTeamStore } from "@/store/team-store";

export function ClawHubSkillMarketplaceSection({ compact = false }: { compact?: boolean }) {
  const {
    activeTeamId,
    loaded: teamsLoaded,
    loadTeams,
    getActiveTeam,
  } = useTeamStore();
  const [personalConfig, setPersonalConfig] = useState<ClawHubPersonalConfig | null>(null);
  const [teamConfig, setTeamConfig] = useState<TeamClawHubConfig | null>(null);
  const [teamStatus, setTeamStatus] = useState<TeamClawHubStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ClawHubRuntimeSkillCandidate[]>([]);
  const [busy, setBusy] = useState<"save" | "verify" | "search" | "install" | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const activeTeam = getActiveTeam();

  useEffect(() => {
    void loadClawHubPersonalConfig().then(setPersonalConfig);
  }, []);

  useEffect(() => {
    if (!teamsLoaded) {
      void loadTeams();
    }
  }, [teamsLoaded, loadTeams]);

  useEffect(() => {
    if (!activeTeamId) {
      setTeamConfig(null);
      setTeamStatus(null);
      return;
    }
    void Promise.allSettled([
      getTeamClawHubConfig(activeTeamId),
      getTeamClawHubStatus(activeTeamId),
    ]).then(([configResult, statusResult]) => {
      setTeamConfig(configResult.status === "fulfilled" ? configResult.value : null);
      setTeamStatus(statusResult.status === "fulfilled" ? statusResult.value : null);
    });
  }, [activeTeamId]);

  const setFeedback = useCallback(
    (type: "success" | "error" | "info", text: string) => {
      setMessage({ type, text });
    },
    [],
  );

  const handleSavePersonal = useCallback(async () => {
    if (!personalConfig) return;
    setBusy("save");
    try {
      const saved = await saveClawHubPersonalConfig({
        siteUrl: DEFAULT_CLAWHUB_SITE_URL,
        registryUrl: DEFAULT_CLAWHUB_REGISTRY_URL,
        token: personalConfig.token,
      });
      setPersonalConfig(saved);
      setFeedback("success", "ClawHub 个人配置已保存");
    } catch (error) {
      handleError(error, { context: "保存 ClawHub 个人配置" });
      setFeedback("error", "保存 ClawHub 个人配置失败");
    } finally {
      setBusy(null);
    }
  }, [personalConfig, setFeedback]);

  const handleVerify = useCallback(async () => {
    setBusy("verify");
    try {
      const result = await verifyClawHubToken({
        token: personalConfig?.token,
        site_url: DEFAULT_CLAWHUB_SITE_URL,
        registry_url: DEFAULT_CLAWHUB_REGISTRY_URL,
      });
      setFeedback("success", result.stdout.trim() || "ClawHub token 验证成功");
    } catch (error) {
      handleError(error, { context: "验证 ClawHub Token" });
      setFeedback(
        "error",
        error instanceof Error ? error.message : "ClawHub token 验证失败",
      );
    } finally {
      setBusy(null);
    }
  }, [personalConfig, setFeedback]);

  const handleSearch = useCallback(async () => {
    const goal = searchQuery.trim();
    if (!goal) return;
    setBusy("search");
    try {
      const entries = await clawHubRuntimeService.searchSkills(goal, {
        limit: 20,
        requireExplicit: false,
        teamId: activeTeamId,
      });
      setSearchResults(entries);
      if (entries.length === 0) {
        setFeedback("info", "没有找到匹配的 ClawHub skill");
      }
    } catch (error) {
      handleError(error, { context: "搜索 ClawHub skills" });
      setFeedback(
        "error",
        error instanceof Error ? error.message : "搜索 ClawHub skills 失败",
      );
    } finally {
      setBusy(null);
    }
  }, [activeTeamId, searchQuery, setFeedback]);

  const handleInstall = useCallback(
    async (entry: ClawHubRuntimeSkillCandidate) => {
      setBusy("install");
      try {
        const result = await clawHubRuntimeService.installSkill(
          {
            slug: entry.slug,
            version: entry.version,
            source: entry.source,
          },
          {
            requireExplicit: false,
            teamId: activeTeamId,
          },
        );
        setFeedback(
          "success",
          `已安装 ${entry.slug}${result.installedVersion ? ` @ ${result.installedVersion}` : ""}`,
        );
      } catch (error) {
        handleError(error, { context: "安装 ClawHub skill" });
        setFeedback(
          "error",
          error instanceof Error ? error.message : "安装 ClawHub skill 失败",
        );
      } finally {
        setBusy(null);
      }
    },
    [activeTeamId, setFeedback],
  );

  return (
    <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className={`font-medium ${compact ? "text-[11px]" : "text-xs"}`}>ClawHub 技能中心</div>
          <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">
            仅在你明确指定 ClawHub 时供模型使用；手动搜索时按 团队代理 → 个人 Token → 公开源 顺序聚合。
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void invoke("open_url", { url: DEFAULT_CLAWHUB_SITE_URL });
          }}
          className="rounded bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
        >
          打开 ClawHub
        </button>
      </div>

      {activeTeamId && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
          <div>当前团队：{activeTeam?.name ?? activeTeamId}</div>
          <div>
            团队共享 Token：
            {teamConfig?.is_active && teamStatus?.can_search
              ? `已启用${teamConfig.masked_token ? `（${teamConfig.masked_token}）` : ""}`
              : "未启用或不可用"}
          </div>
        </div>
      )}

      <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
        <div className="text-[10px] font-medium text-[var(--color-text-secondary)]">个人 ClawHub 配置</div>
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
          官方地址固定为 {DEFAULT_CLAWHUB_SITE_URL}/
        </div>
        <input
          type="password"
          value={personalConfig?.token ?? ""}
          onChange={(event) =>
            setPersonalConfig((current) => ({
              ...(current ?? {
                siteUrl: DEFAULT_CLAWHUB_SITE_URL,
                registryUrl: DEFAULT_CLAWHUB_REGISTRY_URL,
                token: "",
                updatedAt: Date.now(),
              }),
              token: event.target.value,
            }))
          }
          placeholder="个人 Token（可选，私有 skill / 更高配额时填写）"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-blue-500/50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSavePersonal()}
            disabled={busy === "save" || !personalConfig}
            className="rounded bg-[var(--color-bg)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            保存个人配置
          </button>
          <button
            type="button"
            onClick={() => void handleVerify()}
            disabled={busy === "verify" || !(personalConfig?.token ?? "").trim()}
            className="rounded bg-blue-500/15 px-2 py-1 text-[10px] text-blue-500 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
          >
            验证个人 Token
          </button>
        </div>
      </div>

      <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
        <div className="text-[10px] font-medium text-[var(--color-text-secondary)]">手动搜索与安装</div>
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="例如：mysql 导出 / dingtalk / sql export"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-blue-500/50"
          />
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={busy === "search" || !searchQuery.trim()}
            className="rounded bg-blue-500/15 px-2 py-1 text-[10px] text-blue-500 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
          >
            {busy === "search" ? "搜索中..." : "搜索"}
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="space-y-1">
            {searchResults.map((entry) => (
              <div
                key={`${entry.slug}-${entry.version || "latest"}-${entry.source}`}
                className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">
                    {entry.title || entry.slug}
                    {entry.version ? ` · ${entry.version}` : ""}
                  </div>
                  <div className="truncate text-[10px] text-[var(--color-text-secondary)]">
                    {entry.slug}
                    {entry.description ? ` · ${entry.description}` : ""}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    来源：
                    {entry.source === "team_proxy"
                      ? "团队代理"
                      : entry.source === "personal_registry"
                        ? "个人 Token"
                        : "公开源"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleInstall(entry)}
                  disabled={busy === "install" || !entry.installable}
                  className="rounded bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-500 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  安装
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {message && (
        <div
          className={`rounded px-2 py-1 text-[10px] ${
            message.type === "error"
              ? "bg-red-500/10 text-red-500"
              : message.type === "success"
                ? "bg-emerald-500/10 text-emerald-500"
                : "bg-blue-500/10 text-blue-500"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
