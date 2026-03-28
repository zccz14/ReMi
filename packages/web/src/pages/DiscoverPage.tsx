import { useTranslation } from "react-i18next";
import { BookOpen, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const entries = [
  {
    icon: BookOpen,
    titleKey: "discover.reading.title",
    descriptionKey: "discover.reading.description",
    to: "/read",
  },
] as const;

export function DiscoverPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full">
      <h1 className="text-2xl font-bold p-4 pb-2">{t("discover.title")}</h1>

      <div className="p-4 pt-2 space-y-4">
        <p className={cn("text-sm text-muted-foreground")}>{t("discover.subtitle")}</p>
        <p className={cn("text-sm text-muted-foreground")}>{t("discover.selfSubtitle")}</p>
        <div className="rounded-xl bg-card ring-1 ring-foreground/10 overflow-hidden">
          {entries.map((entry) => (
            <Link
              key={entry.to}
              to={entry.to}
              className="flex items-center gap-3 px-4 py-3.5 hover:bg-accent/50 active:bg-accent transition-colors"
            >
              <entry.icon className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{t(entry.titleKey)}</div>
                <div className="text-xs text-muted-foreground">{t(entry.descriptionKey)}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
