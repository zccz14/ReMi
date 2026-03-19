import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { publicKey, keyStore } = useAuth();
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [copied, setCopied] = useState(false);

  const copyPublicKey = async () => {
    await navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => setShowPrivateKey(!showPrivateKey);

  const handleImport = async () => {
    if (!importValue.trim()) return;
    if (!confirm(t("settings.importConfirm"))) return;
    try {
      await keyStore.importPrivateKey(importValue.trim());
      window.location.reload();
    } catch (_err) {
      alert(t("common.error"));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-xl font-bold">{t("settings.title")}</h1>

      {/* Public Key */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.publicKey")}</div>
        <div className="text-xs font-mono break-all text-gray-600">{publicKey}</div>
        <button className="text-sm text-blue-600" onClick={copyPublicKey}>
          {copied ? t("settings.copied") : t("settings.copy")}
        </button>
      </div>

      {/* Export */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <button className="text-sm font-medium text-blue-600" onClick={handleExport}>
          {t("settings.exportKey")}
        </button>
        {showPrivateKey && (
          <div>
            <div className="text-xs text-red-500 mb-1">{t("settings.exportWarning")}</div>
            <div className="text-xs font-mono break-all bg-gray-50 p-2 rounded">
              {keyStore.exportPrivateKey()}
            </div>
          </div>
        )}
      </div>

      {/* Import */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.importKey")}</div>
        <input
          className="w-full border rounded px-2 py-1 text-xs font-mono"
          placeholder={t("settings.importPlaceholder")}
          value={importValue}
          onChange={(e) => setImportValue(e.target.value)}
        />
        <button
          className="text-sm text-blue-600 disabled:opacity-50"
          onClick={handleImport}
          disabled={!importValue.trim()}
        >
          {t("settings.import")}
        </button>
      </div>

      {/* Language */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
        <div className="text-sm font-medium">{t("settings.language")}</div>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={i18n.language}
          onChange={(e) => i18n.changeLanguage(e.target.value)}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
    </div>
  );
}
