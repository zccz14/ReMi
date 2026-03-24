import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BarChart3, Anchor, Share2, Settings, ChevronRight } from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { emptyPublicProfile, resolveProfileSummary } from "../lib/profile";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const menuItems = [
  { icon: BarChart3, labelKey: "me.stats", to: "/stats" },
  { icon: Anchor, labelKey: "me.anchors", to: "/anchors" },
  { icon: Share2, labelKey: "me.share", to: "/share" },
  { icon: Settings, labelKey: "me.settings", to: "/settings" },
] as const;

export function MePage() {
  const { t } = useTranslation();
  const { apiClient, publicKey } = useAuth();
  const [summary, setSummary] = useState(() =>
    resolveProfileSummary(publicKey, emptyPublicProfile),
  );

  useEffect(() => {
    let active = true;

    setSummary(resolveProfileSummary(publicKey, emptyPublicProfile));

    void apiClient
      .get<{ data: typeof emptyPublicProfile }>(apiClient.ownerPath("/profile"))
      .then((res) => {
        if (active) {
          setSummary(resolveProfileSummary(publicKey, res.data ?? emptyPublicProfile));
        }
      })
      .catch(() => {
        if (active) {
          setSummary(resolveProfileSummary(publicKey, emptyPublicProfile));
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, publicKey]);

  return (
    <div className="flex flex-col h-full">
      <h1 className="text-2xl font-bold p-4 pb-2">{t("me.title")}</h1>

      <div className="p-4 pt-2 space-y-4">
        {/* Profile card */}
        <Card>
          <CardContent className="flex items-center gap-4">
            <ChatAvatar
              pubKey={publicKey}
              name={summary.displayName}
              src={summary.avatarUrl ?? undefined}
              size="lg"
            />
            <div className="min-w-0">
              <div className="text-base font-semibold">{summary.displayName}</div>
              {summary.bio ? (
                <div className="text-sm text-muted-foreground">{summary.bio}</div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Menu items */}
        <div className="rounded-xl bg-card ring-1 ring-foreground/10 overflow-hidden">
          {menuItems.map((item, idx) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-3 px-4 py-3.5 hover:bg-accent/50 active:bg-accent transition-colors",
                idx < menuItems.length - 1 && "border-b border-border",
              )}
            >
              <item.icon className="h-5 w-5 text-muted-foreground" />
              <span className="flex-1 text-sm">{t(item.labelKey)}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
