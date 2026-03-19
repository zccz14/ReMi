import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";

interface Stats {
  totalAnchors: number;
  totalMessages: number;
  lastActiveAt: number | null;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: Stats }>(apiClient.ownerPath("/interview/status"))
      .then((res) => setStats(res.data));
  }, [apiClient]);

  const formatTime = (ts: number | null) => {
    if (!ts) return t("dashboard.never");
    return new Date(ts).toLocaleDateString();
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">{t("dashboard.title")}</h1>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="text-2xl font-bold">{stats?.totalAnchors ?? "-"}</div>
          <div className="text-sm text-gray-500">{t("dashboard.anchors")}</div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <div className="text-2xl font-bold">{stats?.totalMessages ?? "-"}</div>
          <div className="text-sm text-gray-500">{t("dashboard.messages")}</div>
        </div>
      </div>

      <div className="text-sm text-gray-500">
        {t("dashboard.lastActive")}: {formatTime(stats?.lastActiveAt ?? null)}
      </div>

      <div className="space-y-2">
        <Link
          to="/interview"
          className="block w-full text-center bg-blue-600 text-white rounded-lg py-3 font-medium"
        >
          {t("dashboard.startInterview")}
        </Link>
        <div className="grid grid-cols-2 gap-2">
          <Link to="/anchors" className="text-center bg-gray-100 rounded-lg py-3 text-sm">
            {t("dashboard.viewAnchors")}
          </Link>
          <Link to="/share" className="text-center bg-gray-100 rounded-lg py-3 text-sm">
            {t("dashboard.shareAvatar")}
          </Link>
        </div>
      </div>
    </div>
  );
}
