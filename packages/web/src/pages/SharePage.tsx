import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function SharePage() {
  const { t } = useTranslation();
  const { publicKey } = useAuth();

  const shareUrl = `${window.location.origin}/s/${publicKey}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <div className="p-4 flex flex-col items-center space-y-6">
      <h1 className="text-xl font-bold">{t("share.title")}</h1>
      <p className="text-sm text-muted-foreground text-center">{t("share.description")}</p>

      <Card>
        <CardContent className="p-6">
          <QRCodeSVG value={shareUrl} size={200} />
        </CardContent>
      </Card>

      <div className="text-xs font-mono text-muted-foreground break-all text-center max-w-[300px]">
        {shareUrl}
      </div>

      <Button onClick={copyLink}>{t("share.copyLink")}</Button>
    </div>
  );
}
