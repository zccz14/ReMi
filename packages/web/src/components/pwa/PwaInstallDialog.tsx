import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { InstallPlatform } from "@/lib/pwa-install";

type PwaInstallDialogProps = {
  open: boolean;
  platform: InstallPlatform;
  shouldShowBrowserOpenHint: boolean;
  onClose: () => void;
};

export function PwaInstallDialog({
  open,
  platform,
  shouldShowBrowserOpenHint,
  onClose,
}: PwaInstallDialogProps) {
  const { t } = useTranslation();
  const steps = t(`me.install.steps.${platform}`, { returnObjects: true }) as string[];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("me.install.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("me.install.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {shouldShowBrowserOpenHint ? (
            <p className="text-sm text-muted-foreground">{t("me.install.browserOpenHint")}</p>
          ) : null}

          <p className="text-sm text-muted-foreground">{t("me.install.fallbackHint")}</p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("me.install.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
