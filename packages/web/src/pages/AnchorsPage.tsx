import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/use-auth";
import { useAnchors } from "../hooks/use-anchors";

export function AnchorsPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const { anchors, loading, create, update, remove } = useAnchors(apiClient);
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editQ, setEditQ] = useState("");
  const [editA, setEditA] = useState("");

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

  const [adding, setAdding] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");

  const handleAdd = async () => {
    if (!newQ.trim()) return;
    await create(newQ.trim(), newA.trim() || undefined);
    setNewQ("");
    setNewA("");
    setAdding(false);
  };

  if (loading) return <div className="p-4 text-center text-gray-400">Loading...</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-3">
        <h1 className="text-xl font-bold">{t("anchors.title")}</h1>
        <input
          className="w-full rounded-lg border px-3 py-2 text-sm"
          placeholder={t("anchors.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-3">
        {filtered.length === 0 && (
          <div className="text-center text-gray-400 py-8">{t("anchors.empty")}</div>
        )}
        {filtered.map((a) => (
          <div key={a.id} className="bg-white rounded-xl p-4 shadow-sm">
            {editId === a.id ? (
              <div className="space-y-2">
                <input
                  className="w-full border rounded px-2 py-1 text-sm"
                  value={editQ}
                  onChange={(e) => setEditQ(e.target.value)}
                />
                <textarea
                  className="w-full border rounded px-2 py-1 text-sm"
                  value={editA}
                  onChange={(e) => setEditA(e.target.value)}
                  rows={3}
                />
                <div className="flex gap-2">
                  <button className="text-sm text-blue-600" onClick={saveEdit}>
                    {t("anchors.save")}
                  </button>
                  <button className="text-sm text-gray-400" onClick={() => setEditId(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div onClick={() => startEdit(a)} className="cursor-pointer">
                <div className="font-medium text-sm">{a.question}</div>
                <div className="text-sm text-gray-500 mt-1">
                  {a.answer || t("anchors.noAnswer")}
                </div>
              </div>
            )}
            {editId !== a.id && (
              <button
                className="text-xs text-red-400 mt-2"
                onClick={() => {
                  if (confirm(t("anchors.confirmDelete"))) remove(a.id);
                }}
              >
                {t("anchors.delete")}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 space-y-2">
        {adding ? (
          <div className="bg-white rounded-xl p-4 shadow-sm space-y-2">
            <input
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder={t("anchors.question")}
              value={newQ}
              onChange={(e) => setNewQ(e.target.value)}
              autoFocus
            />
            <textarea
              className="w-full border rounded px-2 py-1 text-sm"
              placeholder={t("anchors.answer")}
              value={newA}
              onChange={(e) => setNewA(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <button className="text-sm text-blue-600" onClick={handleAdd} disabled={!newQ.trim()}>
                {t("anchors.save")}
              </button>
              <button className="text-sm text-gray-400" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="w-full bg-blue-600 text-white rounded-lg py-3 text-sm font-medium"
            onClick={() => setAdding(true)}
          >
            + {t("anchors.add")}
          </button>
        )}
      </div>
    </div>
  );
}
