import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";

export function DiscoverPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full">
      <h1 className="text-2xl font-bold p-4 pb-2">{t("discover.title")}</h1>

      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4">
        <Compass className="h-16 w-16 text-muted-foreground/50" />
        <p className={cn("text-muted-foreground")}>{t("discover.subtitle")}</p>
        <p className="text-sm text-muted-foreground/60">{t("discover.comingSoon")}</p>
      </div>
    </div>
  );
}
