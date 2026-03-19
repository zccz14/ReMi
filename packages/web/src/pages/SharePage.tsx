import { useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "../hooks/use-auth";

export function SharePage() {
  const { t } = useTranslation();
  const { publicKey } = useAuth();
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/s/${publicKey}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-4 flex flex-col items-center space-y-6">
      <h1 className="text-xl font-bold">{t("share.title")}</h1>
      <p className="text-sm text-gray-500 text-center">{t("share.description")}</p>

      <div className="bg-white p-6 rounded-2xl shadow-sm">
        <QRCodeSVG value={shareUrl} size={200} />
      </div>

      <div className="text-xs font-mono text-gray-500 break-all text-center max-w-[300px]">
        {shareUrl}
      </div>

      <button
        className="bg-blue-600 text-white rounded-lg px-6 py-3 text-sm font-medium"
        onClick={copyLink}
      >
        {copied ? t("share.copied") : t("share.copyLink")}
      </button>
    </div>
  );
}
