import { useCallback, useEffect, useState } from "react";
import { Loader2, FolderOpen, FileText, GitBranch, X } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import type { SharedResource } from "@/store/team-store";

export function TeamResourcesSection({
  teamId,
  isOwnerOrAdmin,
}: {
  teamId: string;
  isOwnerOrAdmin: boolean;
}) {
  const [resources, setResources] = useState<SharedResource[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchResources = useCallback(async () => {
    try {
      const res = await api.get<{ resources: SharedResource[] }>(
        `/teams/${teamId}/resources`,
      );
      setResources(res.resources || []);
    } catch (err) {
      handleError(err, { context: "获取团队共享资源" });
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const handleUnshare = async (resourceId: string) => {
    if (!confirm("确定要取消共享该资源吗？")) return;
    try {
      await api.delete(`/teams/${teamId}/resources/${resourceId}`);
      await fetchResources();
    } catch (err) {
      handleError(err, { context: "取消共享资源" });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold">共享资源</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              团队成员共享的知识库文档和工作流模板
            </p>
          </div>
        </div>

        {resources.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <FolderOpen className="w-6 h-6 mx-auto mb-2 opacity-20" />
            <p className="text-xs">暂无共享资源</p>
            <p className="text-[10px] mt-0.5 opacity-60">
              在知识库或工作流中选择「共享到团队」即可
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {resources.map((resource) => (
              <div
                key={resource.id}
                className="flex items-center justify-between py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  {resource.resource_type === "knowledge_doc" ? (
                    <FileText className="w-3.5 h-3.5 text-blue-500" />
                  ) : (
                    <GitBranch className="w-3.5 h-3.5 text-emerald-500" />
                  )}
                  <div>
                    <div className="text-xs font-medium">
                      {resource.resource_name || resource.resource_id}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {resource.resource_type === "knowledge_doc"
                        ? "知识库文档"
                        : "工作流模板"}{" "}
                      · 由 {resource.username || "成员"} 共享 ·{" "}
                      {new Date(resource.shared_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>

                {isOwnerOrAdmin && (
                  <button
                    onClick={() => handleUnshare(resource.id)}
                    className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="取消共享"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
