import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { ApprovalCandidate, ApprovalKind } from "../../lib/approval-api";

export interface ApprovalTargetAsset {
  id: string;
  question: string;
  answer: string | null;
  updatedAt: number;
}

export interface CandidateDetailSubmitPayload {
  candidate: ApprovalCandidate;
  question: string;
  answer: string | null;
  mode: "create_new" | "update_existing";
  targetAssetId?: string;
  targetUpdatedAt?: number;
}

interface CandidateDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: ApprovalCandidate;
  kind: ApprovalKind;
  assets: ApprovalTargetAsset[];
  onApprove: (payload: CandidateDetailSubmitPayload) => void | Promise<void>;
  onKeepQuestionOnly: (payload: CandidateDetailSubmitPayload) => void | Promise<void>;
}

function getSourceContext(snapshot: ApprovalCandidate["sourceSnapshot"]) {
  if (!snapshot) {
    return "No source context available.";
  }

  if (typeof snapshot === "string") {
    return snapshot;
  }

  return Object.values(snapshot)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export function CandidateDetailSheet({
  open,
  onOpenChange,
  candidate,
  kind,
  assets,
  onApprove,
  onKeepQuestionOnly,
}: CandidateDetailSheetProps) {
  const [question, setQuestion] = useState(candidate.question);
  const [answer, setAnswer] = useState(candidate.answer ?? "");
  const [mode, setMode] = useState<"create_new" | "update_existing">("create_new");
  const [targetAssetId, setTargetAssetId] = useState(assets[0]?.id ?? "");

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuestion(candidate.question);
    setAnswer(candidate.answer ?? "");
    setMode("create_new");
    setTargetAssetId(assets[0]?.id ?? "");
  }, [assets, candidate, open]);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === targetAssetId) ?? null,
    [assets, targetAssetId],
  );

  const payload = useMemo(
    () => ({
      candidate,
      question: question.trim(),
      answer: answer.trim() || null,
      mode,
      targetAssetId: mode === "update_existing" ? selectedAsset?.id : undefined,
      targetUpdatedAt: mode === "update_existing" ? selectedAsset?.updatedAt : undefined,
    }),
    [answer, candidate, mode, question, selectedAsset],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-md rounded-t-3xl p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Candidate details</DialogTitle>
          <DialogDescription>
            Review source context, tighten the wording, and decide whether to create or update.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 pb-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">Source context</div>
            <div className="rounded-2xl bg-muted p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {getSourceContext(candidate.sourceSnapshot)}
            </div>
          </div>

          <label className="block space-y-2 text-sm">
            <span className="font-medium">Question</span>
            <Input
              aria-label="Question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>

          <label className="block space-y-2 text-sm">
            <span className="font-medium">Answer</span>
            <Textarea
              aria-label="Answer"
              rows={4}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>

          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">Save destination</legend>
            <label className="flex items-center gap-2">
              <input
                checked={mode === "create_new"}
                name={`approval-mode-${candidate.id}`}
                type="radio"
                onChange={() => setMode("create_new")}
              />
              <span>Create new</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                aria-label="Update existing"
                checked={mode === "update_existing"}
                name={`approval-mode-${candidate.id}`}
                type="radio"
                onChange={() => setMode("update_existing")}
              />
              <span>Update existing</span>
            </label>
          </fieldset>

          {mode === "update_existing" && (
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Existing asset</span>
              <select
                aria-label="Existing asset"
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={targetAssetId}
                onChange={(event) => setTargetAssetId(event.target.value)}
              >
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.question}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {kind === "anchor" && (
            <Button variant="secondary" onClick={() => void onKeepQuestionOnly(payload)}>
              Keep question only
            </Button>
          )}
          <Button onClick={() => void onApprove(payload)}>
            {kind === "probe" ? "Approve probe" : "Approve candidate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
