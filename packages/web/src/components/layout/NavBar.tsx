import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Home, MessageSquare, Anchor, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems: { path: string; labelKey: string; icon: LucideIcon }[] = [
  { path: "/", labelKey: "nav.dashboard", icon: Home },
  { path: "/interview", labelKey: "nav.interview", icon: MessageSquare },
  { path: "/anchors", labelKey: "nav.anchors", icon: Anchor },
  { path: "/settings", labelKey: "nav.settings", icon: Settings },
];

export function NavBar() {
  const { pathname } = useLocation();
  const { t } = useTranslation();

  return (
    <nav className="flex justify-around border-t bg-card py-2">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.path}
            to={item.path}
            className={cn(
              "flex flex-col items-center gap-0.5 text-xs transition-colors py-1 px-3",
              pathname === item.path
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
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
