import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalTabs } from "../components/approval/ApprovalTabs";
import { useApprovalCenter } from "../hooks/use-approval-center";
import { useAuth } from "../hooks/use-auth";
import { createApprovalApi, type ApprovalKind } from "../lib/approval-api";
import { CandidateCard } from "../components/approval/CandidateCard";
import type {
  ApprovalTargetAsset,
  CandidateDetailSubmitPayload,
} from "../components/approval/CandidateDetailSheet";

const LAST_APPROVAL_PATH_STORAGE_KEY = "remi.last-approval-path";

function mapRouteKind(routeKind: string | undefined): ApprovalKind | null {
  if (routeKind === "anchors") {
    return "anchor";
  }

  if (routeKind === "probes") {
    return "probe";
  }

  return null;
}

export function ApprovalPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const location = useLocation();
  const { kind: routeKind } = useParams<{ kind: string }>();
  const approvalKind = mapRouteKind(routeKind) ?? "anchor";
  const pageKind = routeKind === "probes" ? "probes" : "anchors";
  const isInvalidRoute = routeKind !== "anchors" && routeKind !== "probes";
  const approvalApi = useMemo(() => createApprovalApi(apiClient), [apiClient]);
  const [assets, setAssets] = useState<ApprovalTargetAsset[]>([]);

  useEffect(() => {
    if (routeKind === "anchors" || routeKind === "probes") {
      window.localStorage.setItem(LAST_APPROVAL_PATH_STORAGE_KEY, location.pathname);
    }
  }, [location.pathname, routeKind]);

  useEffect(() => {
    let cancelled = false;

    async function loadAssets() {
      try {
        const response = await apiClient.get<{
          data: {
            items: Array<{
              id: string;
              question: string;
              answer: string | null;
              updatedAt: number;
            }>;
          };
        }>(apiClient.ownerPath("/anchors?limit=200"));

        if (!cancelled) {
          setAssets(response.data.items);
        }
      } catch {
        if (!cancelled) {
          setAssets([]);
        }
      }
    }

    void loadAssets();

    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const approvalCenter = useApprovalCenter({
    api: approvalApi,
    kind: approvalKind,
  });
  const { candidates, loading, total, lastActionId } = approvalCenter;

  const handleApprove = async ({
    candidate,
    mode,
    targetAssetId,
    targetUpdatedAt,
  }: CandidateDetailSubmitPayload) => {
    await approvalCenter.approve(candidate, { mode, targetAssetId, targetUpdatedAt });
  };

  const handleQuestionOnly = async ({
    candidate,
    mode,
    targetAssetId,
    targetUpdatedAt,
  }: CandidateDetailSubmitPayload) => {
    await approvalCenter.keepQuestionOnly(candidate, { mode, targetAssetId, targetUpdatedAt });
  };

  if (isInvalidRoute) {
    return <Navigate to="/approval/anchors" replace />;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b bg-card px-4 pb-4 pt-6 shadow-sm">
        <div className="space-y-2">
          <div>
            <p className="text-sm text-muted-foreground">{t("approval.navLabel")}</p>
            <h1 className="text-2xl font-semibold">{t("approval.title")}</h1>
          </div>
          <ApprovalTabs currentKind={pageKind} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t("approval.pending", { count: total })}</p>
          <Badge variant="secondary">{t(`approval.tabs.${pageKind}`)}</Badge>
        </div>

        <Card>
          <CardContent className="space-y-3 p-4">
            {loading ? (
              <div className="space-y-3" data-testid="approval-loading">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-24 w-full rounded-2xl" />
              </div>
            ) : candidates[0] ? (
              <CandidateCard
                candidate={candidates[0]}
                kind={approvalKind}
                assets={assets}
                lastActionId={lastActionId}
                onApprove={handleApprove}
                onKeepQuestionOnly={handleQuestionOnly}
                onReject={async (candidate) => {
                  await approvalCenter.reject(candidate);
                }}
                onSkipProbe={async (candidate) => {
                  await approvalCenter.skipProbe(candidate);
                }}
                onUndo={async () => {
                  await approvalCenter.undo();
                }}
              />
            ) : (
              <div className="space-y-2 text-center">
                <p className="text-sm font-medium">{t(`approval.empty.${pageKind}`)}</p>
                <p className="text-sm text-muted-foreground">{t("approval.empty.description")}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
