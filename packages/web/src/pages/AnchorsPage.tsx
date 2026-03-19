import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useAnchors } from "../hooks/use-anchors";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function AnchorsPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const { anchors, loading, create, update, remove } = useAnchors(apiClient);
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editQ, setEditQ] = useState("");
  const [editA, setEditA] = useState("");
  const [adding, setAdding] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");

  const filtered = anchors.filter(
    (a) =>
      a.question.toLowerCase().includes(search.toLowerCase()) ||
      (a.answer?.toLowerCase().includes(search.toLowerCase()) ?? false),
  );

  const startEdit = (a: { id: string; question: string; answer: string | null }) => {
    setEditId(a.id);
    setEditQ(a.question);
    setEditA(a.answer ?? "");
  };

  const saveEdit = async () => {
    if (!editId) return;
    await update(editId, { question: editQ, answer: editA || null });
    setEditId(null);
  };

  const handleAdd = async () => {
    if (!newQ.trim()) return;
    await create(newQ.trim(), newA.trim() || undefined);
    setNewQ("");
    setNewA("");
    setAdding(false);
  };

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-8 w-full" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-3">
        <h1 className="text-xl font-bold">{t("anchors.title")}</h1>
        <Input
          placeholder={t("anchors.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-3">
        {filtered.length === 0 && (
          <div className={cn("text-center py-8 text-muted-foreground")}>{t("anchors.empty")}</div>
        )}
        {filtered.map((a) => (
          <Card key={a.id}>
            <CardContent>
              {editId === a.id ? (
                <div className="space-y-2">
                  <Input value={editQ} onChange={(e) => setEditQ(e.target.value)} />
                  <Textarea value={editA} onChange={(e) => setEditA(e.target.value)} rows={3} />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit}>
                      {t("anchors.save")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditId(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div onClick={() => startEdit(a)} className="cursor-pointer space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{a.question}</span>
                      <Badge variant={a.source === "interview" ? "secondary" : "outline"}>
                        {a.source}
                      </Badge>
                    </div>
                    <div className={cn("text-sm text-muted-foreground")}>
                      {a.answer || t("anchors.noAnswer")}
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={<Button variant="destructive" size="xs" className="mt-1" />}
                    >
                      {t("anchors.delete")}
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("anchors.confirmDelete")}</AlertDialogTitle>
                        <AlertDialogDescription>{a.question}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => remove(a.id)}>
                          {t("anchors.delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="p-4 space-y-2">
        {adding ? (
          <Card>
            <CardContent className="space-y-2">
              <Input
                placeholder={t("anchors.question")}
                value={newQ}
                onChange={(e) => setNewQ(e.target.value)}
                autoFocus
              />
              <Textarea
                placeholder={t("anchors.answer")}
                value={newA}
                onChange={(e) => setNewA(e.target.value)}
                rows={3}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd} disabled={!newQ.trim()}>
                  {t("anchors.save")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Button className="w-full" onClick={() => setAdding(true)}>
            + {t("anchors.add")}
          </Button>
        )}
      </div>
    </div>
  );
}
