import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageSquare, Users, CheckSquare2, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const LAST_APPROVAL_PATH_STORAGE_KEY = "remi.last-approval-path";

const navItems: { path: string; labelKey: string; icon: LucideIcon }[] = [
  { path: "/messages", labelKey: "nav.messages", icon: MessageSquare },
  { path: "/contacts", labelKey: "nav.contacts", icon: Users },
  { path: "/approval/anchors", labelKey: "nav.approval", icon: CheckSquare2 },
  { path: "/me", labelKey: "nav.me", icon: User },
];

function getApprovalPath(pathname: string) {
  if (pathname === "/approval/anchors" || pathname === "/approval/probes") {
    return pathname;
  }

  const stored = window.localStorage.getItem(LAST_APPROVAL_PATH_STORAGE_KEY);
  return stored === "/approval/probes" || stored === "/approval/anchors"
    ? stored
    : "/approval/anchors";
}

export function NavBar() {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const approvalPath = getApprovalPath(pathname);

  return (
    <nav className="flex justify-around border-t bg-card py-2">
      {navItems.map((item) => {
        const Icon = item.icon;
        const path = item.path === "/approval/anchors" ? approvalPath : item.path;
        const isActive =
          item.path === "/approval/anchors"
            ? pathname.startsWith("/approval/")
            : pathname === item.path;
        return (
          <Link
            key={item.labelKey}
            to={path}
            className={cn(
              "flex flex-col items-center gap-0.5 text-xs transition-colors py-1 px-3",
              isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-5" />
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
