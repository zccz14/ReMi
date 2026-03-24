import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type BootstrapStatus = "loading" | "ready" | "error";

export function SharePage() {
  const { t } = useTranslation();
  const { publicKey, apiClient } = useAuth();
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>("loading");

  useEffect(() => {
    let active = true;

    setBootstrapStatus("loading");

    void Promise.resolve(apiClient.get(apiClient.ownerPath("/profile")))
      .then(() => {
        if (active) {
          setBootstrapStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setBootstrapStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient]);

  const shareUrl = `${window.location.origin}/profile/${publicKey}`;

  const copyLink = async () => {
    if (bootstrapStatus !== "ready") return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <FullScreenLayout title={t("share.title")}>
      <div className="p-4 flex flex-col items-center space-y-6">
        <p className="text-sm text-muted-foreground text-center">{t("share.description")}</p>

        {bootstrapStatus === "loading" ? (
          <p className="text-sm text-muted-foreground text-center">{t("share.bootstrapping")}</p>
        ) : null}

        {bootstrapStatus === "error" ? (
          <p className="text-sm text-destructive text-center">{t("share.bootstrapError")}</p>
        ) : null}

        <Card>
          <CardContent className="p-6">
            {bootstrapStatus === "ready" ? <QRCodeSVG value={shareUrl} size={200} /> : null}
          </CardContent>
        </Card>

        {bootstrapStatus === "ready" ? (
          <div className="text-xs font-mono text-muted-foreground break-all text-center max-w-[300px]">
            {shareUrl}
          </div>
        ) : null}

        <Button onClick={copyLink} disabled={bootstrapStatus !== "ready"}>
          {t("share.copyLink")}
        </Button>
      </div>
    </FullScreenLayout>
  );
}
