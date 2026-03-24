import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import {
  loadClawHubPersonalConfig,
  saveClawHubPersonalConfig,
  type ClawHubPersonalConfig,
} from "@/core/agent/skills/clawhub-config";
import {
  getTeamClawHubConfig,
  getTeamClawHubStatus,
  installTeamPublishedSkill,
  installTeamClawHubSkill,
  listTeamPublishedSkills,
  searchTeamClawHubSkills,
  type TeamClawHubConfig,
  type TeamClawHubSearchEntry,
  type TeamClawHubStatus,
  type TeamPublishedSkill,
} from "@/core/agent/skills/clawhub-team-api";
import {
  getClawHubCliStatus,
  installClawHubSkill,
  verifyClawHubToken,
  type ClawHubCliStatus,
} from "@/core/agent/skills/clawhub-tauri";
import { useTeamStore } from "@/store/team-store";
import { useSkillStore } from "@/store/skill-store";

export function ClawHubSkillMarketplaceSection({ compact = false }: { compact?: boolean }) {
  const { importMarketplaceFromMd } = useSkillStore();
  const {
    activeTeamId,
    loaded: teamsLoaded,
    loadTeams,
    getActiveTeam,
  } = useTeamStore();
  const [cliStatus, setCliStatus] = useState<ClawHubCliStatus | null>(null);
  const [personalConfig, setPersonalConfig] = useState<ClawHubPersonalConfig | null>(null);
  const [teamConfig, setTeamConfig] = useState<TeamClawHubConfig | null>(null);
  const [teamStatus, setTeamStatus] = useState<TeamClawHubStatus | null>(null);
  const [preferredSource, setPreferredSource] = useState<"personal" | "team">("personal");
  const [publishedSkills, setPublishedSkills] = useState<TeamPublishedSkill[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<TeamClawHubSearchEntry[]>([]);
  const [searchRawOutput, setSearchRawOutput] = useState("");
  const [searchCached, setSearchCached] = useState(false);
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState<"save" | "verify" | "install" | "search" | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const activePublishedSkills = useMemo(
    () => publishedSkills.filter((skill) => skill.is_active),
    [publishedSkills],
  );
  const setFeedback = useCallback((type: "success" | "error" | "info", text: string) => {
    setMessage({ type, text });
  }, []);

  useEffect(() => {
    void getClawHubCliStatus().then(setCliStatus).catch(() => {
      setCliStatus({ installed: false });
    });
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
      setPublishedSkills([]);
      setPreferredSource("personal");
      setSearchResults([]);
      setSearchRawOutput("");
      setSearchCached(false);
      return;
    }
    setSearchResults([]);
    setSearchRawOutput("");
    setSearchCached(false);
    setPublishedLoading(true);
    void Promise.allSettled([
      getTeamClawHubConfig(activeTeamId),
      getTeamClawHubStatus(activeTeamId),
      listTeamPublishedSkills(activeTeamId),
    ])
      .then(([configResult, statusResult, skillsResult]) => {
        if (configResult.status === "fulfilled") {
          setTeamConfig(configResult.value);
          if (configResult.value?.is_active) {
            setPreferredSource("team");
          }
        } else {
          setTeamConfig(null);
        }

        if (statusResult.status === "fulfilled") {
          setTeamStatus(statusResult.value);
        } else {
          setTeamStatus(null);
        }

        if (skillsResult.status === "fulfilled") {
          setPublishedSkills(skillsResult.value);
        } else {
          setPublishedSkills([]);
        }
      })
      .finally(() => setPublishedLoading(false));
  }, [activeTeamId]);

  const refreshTeamRuntime = useCallback(async () => {
    if (!activeTeamId) return;
    setPublishedLoading(true);
    try {
      const [config, status, skills] = await Promise.all([
        getTeamClawHubConfig(activeTeamId),
        getTeamClawHubStatus(activeTeamId),
        listTeamPublishedSkills(activeTeamId),
      ]);
      setTeamConfig(config);
      setTeamStatus(status);
      setPublishedSkills(skills);
    } catch (error) {
      handleError(error, { context: "刷新团队技能中心状态" });
      setFeedback("error", "刷新团队技能库失败");
    } finally {
      setPublishedLoading(false);
    }
  }, [activeTeamId, setFeedback]);

  useEffect(() => {
    if (!activeTeamId) return;
    const refresh = () => {
      void Promise.all([
        getTeamClawHubConfig(activeTeamId).then(setTeamConfig).catch(() => {}),
        getTeamClawHubStatus(activeTeamId).then(setTeamStatus).catch(() => {}),
        listTeamPublishedSkills(activeTeamId).then(setPublishedSkills).catch(() => {}),
      ]);
    };
    const timer = window.setInterval(refresh, 30000);
    const handleVisibleRefresh = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibleRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibleRefresh);
    };
  }, [activeTeamId]);

  const activeTeam = getActiveTeam();
  const teamAvailable = !!activeTeamId && !!teamConfig?.is_active;
  const resolvedSource = teamAvailable && preferredSource === "team" ? "team" : "personal";
  const resolvedConfig = useMemo(() => {
    if (resolvedSource === "team" && activeTeamId && teamConfig?.is_active) {
      return {
        source: "team" as const,
        teamId: activeTeamId,
        siteUrl: teamConfig.site_url,
        registryUrl: teamConfig.registry_url,
        token: "",
      };
    }
    return {
      source: "personal" as const,
      siteUrl: personalConfig?.siteUrl ?? "",
      registryUrl: personalConfig?.registryUrl ?? "",
      token: personalConfig?.token ?? "",
    };
  }, [resolvedSource, activeTeamId, teamConfig, personalConfig]);

  const handleSavePersonal = useCallback(async () => {
    if (!personalConfig) return;
    setBusy("save");
    try {
      const saved = await saveClawHubPersonalConfig({
        siteUrl: personalConfig.siteUrl,
        registryUrl: personalConfig.registryUrl,
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
    if (resolvedSource === "team") {
      setFeedback("info", "团队配置验证已迁移到服务端，请在团队管理页由管理员执行。");
      return;
    }
    setBusy("verify");
    try {
      const result = await verifyClawHubToken({
        token: personalConfig?.token,
        site_url: personalConfig?.siteUrl,
        registry_url: personalConfig?.registryUrl,
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
  }, [personalConfig, resolvedSource, setFeedback]);

  const performInstall = useCallback(async (installSlug: string, installVersion?: string) => {
    const trimmedSlug = installSlug.trim();
    const trimmedVersion = installVersion?.trim() ?? "";
    if (!trimmedSlug) return false;
    setBusy("install");
    try {
      const installResult = resolvedSource === "team" && activeTeamId
        ? await installTeamClawHubSkill({
          teamId: activeTeamId,
          slug: trimmedSlug,
          ...(trimmedVersion ? { version: trimmedVersion } : {}),
        })
        : await installClawHubSkill({
          slug: trimmedSlug,
          ...(trimmedVersion ? { version: trimmedVersion } : {}),
          token: personalConfig?.token,
          site_url: personalConfig?.siteUrl,
          registry_url: personalConfig?.registryUrl,
        });
      const skill = await importMarketplaceFromMd({
        content: installResult.skill_md,
        marketplaceMeta: {
          provider: "clawhub",
          slug: trimmedSlug,
          ...(trimmedVersion ? { remoteVersion: trimmedVersion } : {}),
          installedVia: resolvedSource,
          ...(activeTeamId && resolvedSource === "team" ? { teamId: activeTeamId } : {}),
          siteUrl: resolvedSource === "team" ? teamConfig?.site_url : personalConfig?.siteUrl,
          registryUrl: resolvedSource === "team" ? teamConfig?.registry_url : personalConfig?.registryUrl,
        },
      });
      if (!skill) {
        setFeedback("error", "已从 ClawHub 下载，但当前项目无法解析这个 SKILL.md");
        return false;
      }
      setFeedback("success", `已从 ClawHub 安装技能：${skill.name}`);
      setSlug("");
      setVersion("");
      return true;
    } catch (error) {
      handleError(error, { context: "从 ClawHub 安装技能" });
      setFeedback(
        "error",
        error instanceof Error ? error.message : "从 ClawHub 安装技能失败",
      );
      return false;
    } finally {
      setBusy(null);
    }
  }, [
    activeTeamId,
    importMarketplaceFromMd,
    personalConfig,
    resolvedSource,
    setFeedback,
    teamConfig,
  ]);

  const handleInstall = useCallback(async () => {
    await performInstall(slug, version);
  }, [performInstall, slug, version]);

  const handleInstallPublished = useCallback(async (skill: TeamPublishedSkill) => {
    if (!activeTeamId) return;
    setBusy("install");
    try {
      const installResult = await installTeamPublishedSkill({
        teamId: activeTeamId,
        skillId: skill.id,
      });
      const imported = await importMarketplaceFromMd({
        content: installResult.skill_md,
        marketplaceMeta: {
          provider: "clawhub",
          slug: skill.slug,
          ...(skill.version ? { remoteVersion: skill.version } : {}),
          installedVia: "team",
          teamId: activeTeamId,
          siteUrl: teamConfig?.site_url,
          registryUrl: teamConfig?.registry_url,
        },
      });
      if (!imported) {
        setFeedback("error", "团队技能已拉取，但当前项目无法解析这个 SKILL.md");
        return;
      }
      setFeedback("success", `已从团队技能库安装：${imported.name}`);
    } catch (error) {
      handleError(error, { context: "安装团队已发布技能" });
      setFeedback(
        "error",
        error instanceof Error ? error.message : "安装团队已发布技能失败",
      );
    } finally {
      setBusy(null);
    }
  }, [activeTeamId, importMarketplaceFromMd, setFeedback, teamConfig]);

  const handleSearch = useCallback(async () => {
    const trimmedQuery = searchQuery.trim();
    if (!activeTeamId || resolvedSource !== "team" || !trimmedQuery) return;
    setBusy("search");
    try {
      const result = await searchTeamClawHubSkills({
        teamId: activeTeamId,
        query: trimmedQuery,
        limit: 20,
      });
      setSearchResults(result.entries ?? []);
      setSearchRawOutput(result.raw_output ?? "");
      setSearchCached(result.cached === true);
      if ((result.entries?.length ?? 0) === 0) {
        setFeedback("info", "已查询团队 ClawHub，但没有解析到结构化结果，可参考下方原始输出。");
      }
    } catch (error) {
      handleError(error, { context: "搜索团队 ClawHub 技能" });
      setFeedback(
        "error",
        error instanceof Error ? error.message : "搜索团队 ClawHub 技能失败",
      );
    } finally {
      setBusy(null);
    }
  }, [activeTeamId, resolvedSource, searchQuery, setFeedback]);

  return (
    <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className={`font-medium ${compact ? "text-[11px]" : "text-xs"}`}>ClawHub 技能中心</div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            目前支持按 slug 安装到本地 Skill。团队配置走服务端代理安装，个人配置仍使用本地 `clawhub` CLI。
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const url = resolvedConfig.siteUrl || "https://clawhub.com";
            void invoke("open_url", { url });
          }}
          className="px-2 py-1 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
        >
          打开 ClawHub
        </button>
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)]">
        CLI 状态：
        {cliStatus == null
          ? "检测中..."
          : cliStatus.installed
            ? `已安装${cliStatus.version ? ` (${cliStatus.version})` : ""}`
            : "未检测到 clawhub CLI，请先在系统安装后再使用"}
        {resolvedSource === "team" && "（当前为团队模式，安装不依赖本地 CLI）"}
      </div>

      {resolvedSource === "team" && (
        <div className={`text-[10px] px-2 py-1 rounded ${
          teamStatus?.can_search
            ? "bg-emerald-500/10 text-emerald-500"
            : "bg-amber-500/10 text-amber-500"
        }`}>
          {teamStatus == null
            ? "正在检查团队 ClawHub 服务端状态..."
            : teamStatus.can_search
              ? `服务端 ClawHub 可用${teamStatus.cli_version ? ` (${teamStatus.cli_version})` : ""}，可实时搜索与安装`
              : !teamStatus.configured
                ? "团队尚未配置 ClawHub，请先由管理员配置"
                : !teamStatus.active
                  ? "团队 ClawHub 配置已存在但未启用"
                  : "服务端未检测到可用的 clawhub CLI，团队实时搜索/安装不可用"}
        </div>
      )}

      {teamAvailable && (
        <div className="flex items-center gap-2 text-[10px]">
          <button
            type="button"
            onClick={() => setPreferredSource("team")}
            className={`px-2 py-1 rounded transition-colors ${
              preferredSource === "team"
                ? "bg-blue-500/15 text-blue-500"
                : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
            }`}
          >
            团队配置
          </button>
          <button
            type="button"
            onClick={() => setPreferredSource("personal")}
            className={`px-2 py-1 rounded transition-colors ${
              preferredSource === "personal"
                ? "bg-blue-500/15 text-blue-500"
                : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
            }`}
          >
            个人配置
          </button>
          <span className="text-[var(--color-text-secondary)]">
            当前团队：{activeTeam?.name ?? activeTeamId}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="space-y-1">
          <div className="text-[10px] text-[var(--color-text-secondary)]">站点地址</div>
          <input
            value={personalConfig?.siteUrl ?? ""}
            onChange={(event) => setPersonalConfig((current) => ({
              ...(current ?? { siteUrl: "", registryUrl: "", token: "", updatedAt: Date.now() }),
              siteUrl: event.target.value,
            }))}
            disabled={resolvedSource === "team"}
            className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50 disabled:opacity-60"
          />
        </label>
        <label className="space-y-1">
          <div className="text-[10px] text-[var(--color-text-secondary)]">Registry 地址</div>
          <input
            value={personalConfig?.registryUrl ?? ""}
            onChange={(event) => setPersonalConfig((current) => ({
              ...(current ?? { siteUrl: "", registryUrl: "", token: "", updatedAt: Date.now() }),
              registryUrl: event.target.value,
            }))}
            disabled={resolvedSource === "team"}
            className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50 disabled:opacity-60"
          />
        </label>
      </div>

      <label className="space-y-1">
        <div className="text-[10px] text-[var(--color-text-secondary)]">
          {resolvedSource === "team" ? "团队 Token" : "个人 Token"}
        </div>
        {resolvedSource === "team" ? (
          <div className="px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
            {teamConfig?.masked_token || "团队已配置 Token（仅服务端保存，成员侧不展示明文）"}
          </div>
        ) : (
          <input
            type="password"
            value={personalConfig?.token ?? ""}
            onChange={(event) => setPersonalConfig((current) => ({
              ...(current ?? { siteUrl: "", registryUrl: "", token: "", updatedAt: Date.now() }),
              token: event.target.value,
            }))}
            className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
            placeholder="可选：私有技能或受限访问时填写"
          />
        )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSavePersonal()}
          disabled={resolvedSource === "team" || busy === "save" || !personalConfig}
          className="px-2 py-1 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
        >
          保存个人配置
        </button>
        <button
          type="button"
          onClick={() => void handleVerify()}
          disabled={resolvedSource === "team" || busy === "verify" || !cliStatus?.installed}
          className="px-2 py-1 text-[10px] rounded bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
        >
          验证 Token
        </button>
      </div>

      {resolvedSource === "team" && activeTeamId && (
        <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-medium text-[var(--color-text-secondary)]">
                团队已发布技能
              </div>
              <button
                type="button"
                onClick={() => void refreshTeamRuntime()}
                disabled={publishedLoading}
                className="px-2 py-1 text-[10px] rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
              >
                刷新团队库
              </button>
            </div>
            {publishedLoading ? (
              <div className="text-[10px] text-[var(--color-text-secondary)]">加载中...</div>
            ) : activePublishedSkills.length > 0 ? (
              <div className="space-y-1">
                {activePublishedSkills.map((skill) => (
                    <div
                      key={skill.id}
                      className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">
                          {skill.display_name}
                          {skill.version ? ` · ${skill.version}` : ""}
                        </div>
                        <div className="truncate text-[10px] text-[var(--color-text-secondary)]">
                          {skill.slug}
                          {skill.description ? ` · ${skill.description}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSlug(skill.slug);
                            setVersion(skill.version);
                          }}
                          className="px-2 py-1 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                        >
                          填入 slug
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleInstallPublished(skill)}
                          disabled={busy === "install"}
                          className="px-2 py-1 text-[10px] rounded bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
                        >
                          从团队库安装
                        </button>
                      </div>
                    </div>
                ))}
              </div>
            ) : publishedSkills.length > 0 ? (
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                管理员已发布团队技能，但当前都处于停用状态。
              </div>
            ) : (
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                管理员还没有发布团队技能。你也可以继续使用下方实时搜索。
              </div>
            )}
          </div>

          <div className="text-[10px] text-[var(--color-text-secondary)]">
            团队实时搜索：通过服务端代理从 ClawHub 查询最新技能，不会把团队 Token 下发到客户端。
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="输入关键词，例如 sql export / mysql / dingtalk"
              className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={busy === "search" || !searchQuery.trim() || !teamStatus?.can_search}
              className="px-3 py-1.5 text-xs rounded bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
            >
              搜索 ClawHub
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                共找到 {searchResults.length} 条结果{searchCached ? "（30 秒缓存）" : "（实时结果）"}
              </div>
              {searchResults.map((entry) => (
                <div
                  key={entry.slug}
                  className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{entry.title || entry.slug}</div>
                    <div className="truncate text-[10px] text-[var(--color-text-secondary)]">
                      {entry.slug}
                      {entry.description ? ` · ${entry.description}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setSlug(entry.slug)}
                      className="px-2 py-1 text-[10px] rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
                    >
                      填入 slug
                    </button>
                    <button
                      type="button"
                      onClick={() => void performInstall(entry.slug)}
                      disabled={busy === "install" || !teamStatus?.can_install}
                      className="px-2 py-1 text-[10px] rounded bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
                    >
                      直接安装
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!searchResults.length && searchRawOutput && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
              {searchRawOutput}
            </pre>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_160px_auto]">
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="输入 ClawHub skill slug，例如 team/sql-export"
          className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
        />
        <input
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          placeholder="可选版本"
          className="w-full px-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-blue-500/50"
        />
        <button
          type="button"
          onClick={() => void handleInstall()}
          disabled={
            busy === "install"
            || !slug.trim()
            || (resolvedSource === "personal" && !cliStatus?.installed)
            || (resolvedSource === "team" && !teamStatus?.can_install)
          }
          className="px-3 py-1.5 text-xs rounded bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
        >
          安装到本地
        </button>
      </div>

      {message && (
        <div className={`text-[10px] px-2 py-1 rounded ${
          message.type === "error"
            ? "bg-red-500/10 text-red-500"
            : message.type === "success"
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-blue-500/10 text-blue-500"
        }`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
