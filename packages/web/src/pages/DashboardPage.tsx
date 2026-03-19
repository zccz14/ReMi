import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Stats {
  totalAnchors: number;
  totalMessages: number;
  lastActiveAt: number | null;
}

export function DashboardPage() {
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
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">{t("dashboard.title")}</h1>

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
                <div className={cn("text-sm text-muted-foreground")}>{t("dashboard.anchors")}</div>
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
                <div className={cn("text-sm text-muted-foreground")}>{t("dashboard.messages")}</div>
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

      <div className="space-y-2">
        <Button render={<Link to="/interview" />} className="w-full py-3">
          {t("dashboard.startInterview")}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" render={<Link to="/anchors" />} className="py-3 text-sm">
            {t("dashboard.viewAnchors")}
          </Button>
          <Button variant="outline" render={<Link to="/share" />} className="py-3 text-sm">
            {t("dashboard.shareAvatar")}
          </Button>
        </div>
      </div>
    </div>
  );
}
