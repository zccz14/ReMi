import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function EphemeralWarning({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("bg-yellow-50 text-yellow-800 text-xs text-center py-1 px-2", className)}>
      {t("common.ephemeralWarning")}
    </div>
  );
}
