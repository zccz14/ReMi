import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { publicKey, keyStore } = useAuth();
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [importValue, setImportValue] = useState("");

  const copyPublicKey = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
      toast.success(t("settings.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleExport = () => setShowPrivateKey(!showPrivateKey);

  const handleImport = async () => {
    if (!importValue.trim()) return;
    try {
      await keyStore.importPrivateKey(importValue.trim());
      window.location.reload();
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-xl font-bold">{t("settings.title")}</h1>

      {/* Public Key */}
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-medium">{t("settings.publicKey")}</div>
          <div className="text-xs font-mono break-all text-muted-foreground">{publicKey}</div>
          <Button variant="link" size="sm" onClick={copyPublicKey}>
            {t("settings.copy")}
          </Button>
        </CardContent>
      </Card>

      {/* Export */}
      <Card>
        <CardContent className="space-y-2">
          <Button variant="link" size="sm" onClick={handleExport}>
            {t("settings.exportKey")}
          </Button>
          {showPrivateKey && (
            <div>
              <div className="text-xs text-destructive mb-1">{t("settings.exportWarning")}</div>
              <div className="text-xs font-mono break-all bg-muted p-2 rounded">
                {keyStore.exportPrivateKey()}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import */}
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-medium">{t("settings.importKey")}</div>
          <Input
            className="font-mono text-xs"
            placeholder={t("settings.importPlaceholder")}
            value={importValue}
            onChange={(e) => setImportValue(e.target.value)}
          />
          <Button variant="link" size="sm" onClick={handleImport} disabled={!importValue.trim()}>
            {t("settings.import")}
          </Button>
        </CardContent>
      </Card>

      {/* Language */}
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-medium">{t("settings.language")}</div>
          <Select
            value={i18n.language}
            onValueChange={(value) => value && i18n.changeLanguage(value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}
