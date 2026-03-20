import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Stats {
  totalAnchors: number;
  totalMessages: number;
  lastActiveAt: number | null;
}

export function StatsPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: Stats }>(apiClient.ownerPath("/interview/status"))
      .then((res) => setStats(res.data))
      .catch(() => toast.error(t("common.error")))
      .finally(() => setLoading(false));
  }, [apiClient, t]);

  const formatTime = (ts: number | null) => {
    if (!ts) return t("dashboard.never");
    return new Date(ts).toLocaleDateString();
  };

  return (
    <FullScreenLayout title={t("dashboard.title")}>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent>
              {loading ? (
                <>
                  <Skeleton className="h-8 w-12 mb-1" />
                  <Skeleton className="h-4 w-20" />
                </>
              ) : (
                <>
                  <div className={cn("text-2xl font-bold")}>{stats?.totalAnchors ?? "-"}</div>
                  <div className={cn("text-sm text-muted-foreground")}>
                    {t("dashboard.anchors")}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              {loading ? (
                <>
                  <Skeleton className="h-8 w-12 mb-1" />
                  <Skeleton className="h-4 w-20" />
                </>
              ) : (
                <>
                  <div className={cn("text-2xl font-bold")}>{stats?.totalMessages ?? "-"}</div>
                  <div className={cn("text-sm text-muted-foreground")}>
                    {t("dashboard.messages")}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className={cn("text-sm text-muted-foreground")}>
          {loading ? (
            <Skeleton className="h-4 w-48" />
          ) : (
            <>
              {t("dashboard.lastActive")}: {formatTime(stats?.lastActiveAt ?? null)}
            </>
          )}
        </div>
      </div>
    </FullScreenLayout>
  );
}
