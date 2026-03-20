import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { Button } from "@/components/ui/button";

function truncatePubKey(pubKey: string): string {
  if (pubKey.length <= 13) return pubKey;
  return `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}

export function ProfilePage() {
  const { t } = useTranslation();
  const { pubKey } = useParams<{ pubKey: string }>();
  const navigate = useNavigate();

  if (!pubKey) return null;

  return (
    <FullScreenLayout title={t("profile.title")}>
      <div className="flex flex-col items-center justify-center gap-6 p-8 h-full">
        <ChatAvatar pubKey={pubKey} size="lg" />
        <div className="text-sm font-mono text-muted-foreground break-all text-center max-w-[300px]">
          {truncatePubKey(pubKey)}
        </div>
        <Button onClick={() => navigate(`/chat/${pubKey}`)}>
          <MessageSquare className="h-4 w-4 mr-2" />
          {t("profile.sendMessage")}
        </Button>
      </div>
    </FullScreenLayout>
  );
}
