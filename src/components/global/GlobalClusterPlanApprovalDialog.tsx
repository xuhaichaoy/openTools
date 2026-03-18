import { useClusterPlanApprovalStore } from "@/store/cluster-plan-approval-store";
import { ClusterPlanApprovalDialog } from "@/components/cluster/ClusterPlanApprovalDialog";

export function GlobalClusterPlanApprovalDialog() {
  const active = useClusterPlanApprovalStore((s) => s.active);
  const approve = useClusterPlanApprovalStore((s) => s.approve);
  const reject = useClusterPlanApprovalStore((s) => s.reject);

  if (!active) return null;

  return (
    <ClusterPlanApprovalDialog
      plan={active.plan}
      presentation={active.presentation}
      onApprove={approve}
      onReject={reject}
    />
  );
}
