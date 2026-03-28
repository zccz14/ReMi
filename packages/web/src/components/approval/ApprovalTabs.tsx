import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type ApprovalPathKind = "anchors" | "probes";

interface ApprovalTabsProps {
  currentKind: ApprovalPathKind;
}

const tabItems: Array<{ kind: ApprovalPathKind; labelKey: string }> = [
  { kind: "anchors", labelKey: "approval.tabs.anchors" },
  { kind: "probes", labelKey: "approval.tabs.probes" },
];

export function ApprovalTabs({ currentKind }: ApprovalTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted p-1">
      {tabItems.map((tab) => (
        <Link
          key={tab.kind}
          to={`/approval/${tab.kind}`}
          className={cn(
            "rounded-xl px-3 py-2 text-center text-sm font-medium transition-colors",
            tab.kind === currentKind
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground",
          )}
        >
          {t(tab.labelKey)}
        </Link>
      ))}
    </div>
  );
}
