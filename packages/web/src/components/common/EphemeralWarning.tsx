import { useTranslation } from "react-i18next";

export function EphemeralWarning() {
  const { t } = useTranslation();
  return (
    <div className="bg-yellow-50 text-yellow-800 text-xs text-center py-1 px-2">
      {t("common.ephemeralWarning")}
    </div>
  );
}
