import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Contact {
  pubKey: string;
}

function truncatePubKey(pubKey: string): string {
  if (pubKey.length <= 13) return pubKey;
  return `${pubKey.slice(0, 6)}...${pubKey.slice(-4)}`;
}

function groupByFirstChar(contacts: Contact[]): Map<string, Contact[]> {
  const groups = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const key = contact.pubKey.charAt(0).toUpperCase();
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(contact);
  }
  // Sort groups alphabetically
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function ContactSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="h-11 w-11 rounded-[10px] shrink-0" />
      <Skeleton className="h-4 w-28" />
    </div>
  );
}

export function ContactsPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: Contact[] }>(apiClient.ownerPath("/contacts"))
      .then((res) => setContacts(res.data))
      .catch(() => toast.error(t("common.error")))
      .finally(() => setLoading(false));
  }, [apiClient, t]);

  const grouped = groupByFirstChar(contacts);

  return (
    <div className="flex flex-col h-full">
      <h1 className="text-2xl font-bold p-4 pb-2">{t("contacts.title")}</h1>

      {loading ? (
        <div className="space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <ContactSkeleton key={i} />
          ))}
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <p className={cn("text-muted-foreground text-center")}>{t("contacts.empty")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {[...grouped.entries()].map(([letter, group]) => (
            <div key={letter}>
              <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground bg-muted/30 sticky top-0">
                {letter}
              </div>
              {group.map((contact, idx) => (
                <button
                  key={contact.pubKey}
                  type="button"
                  className={cn(
                    "flex items-center gap-3 w-full text-left px-4 py-3 hover:bg-accent/50 active:bg-accent transition-colors",
                    idx < group.length - 1 && "border-b border-border",
                  )}
                  onClick={() => navigate(`/chat/${contact.pubKey}`)}
                >
                  <ChatAvatar pubKey={contact.pubKey} />
                  <span className="text-sm font-medium">{truncatePubKey(contact.pubKey)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
