import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuth } from "../hooks/use-auth";
import { ChatAvatar } from "../components/chat/ChatAvatar";
import { loadPublicProfileSummary, type ResolvedProfileSummary } from "../lib/profile";
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
  const [profiles, setProfiles] = useState<Record<string, ResolvedProfileSummary>>({});

  useEffect(() => {
    let active = true;

    apiClient
      .get<{ data: Contact[] }>(apiClient.ownerPath("/contacts"))
      .then((res) => {
        if (active) {
          setContacts(res.data);
        }
      })
      .catch(() => {
        if (active) {
          toast.error(t("common.error"));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, t]);

  useEffect(() => {
    const pubKeys = [...new Set(contacts.map((contact) => contact.pubKey))];

    if (pubKeys.length === 0) {
      setProfiles({});
      return;
    }

    let active = true;

    void Promise.all(
      pubKeys.map(async (pubKey) => [pubKey, await loadPublicProfileSummary(pubKey)] as const),
    ).then((entries) => {
      if (active) {
        setProfiles(Object.fromEntries(entries));
      }
    });

    return () => {
      active = false;
    };
  }, [contacts]);

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
              {group.map((contact, idx) => {
                const profile = profiles[contact.pubKey];
                const displayName = profile?.displayName ?? truncatePubKey(contact.pubKey);

                return (
                  <button
                    key={contact.pubKey}
                    type="button"
                    className={cn(
                      "flex items-center gap-3 w-full text-left px-4 py-3 hover:bg-accent/50 active:bg-accent transition-colors",
                      idx < group.length - 1 && "border-b border-border",
                    )}
                    onClick={() => navigate(`/chat/${contact.pubKey}`)}
                  >
                    <ChatAvatar
                      pubKey={contact.pubKey}
                      name={displayName}
                      src={profile?.avatarUrl ?? undefined}
                    />
                    <span className="text-sm font-medium">{displayName}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
