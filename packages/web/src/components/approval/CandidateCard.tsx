import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { ApprovalCandidate, ApprovalKind } from "../../lib/approval-api";
import {
  CandidateDetailSheet,
  type ApprovalTargetAsset,
  type CandidateDetailSubmitPayload,
} from "./CandidateDetailSheet";

interface CandidateCardProps {
  candidate: ApprovalCandidate;
  kind: ApprovalKind;
  assets: ApprovalTargetAsset[];
  lastActionId: string | null;
  onApprove: (payload: CandidateDetailSubmitPayload) => void | Promise<void>;
  onKeepQuestionOnly: (payload: CandidateDetailSubmitPayload) => void | Promise<void>;
  onReject: (candidate: ApprovalCandidate) => void | Promise<void>;
  onSkipProbe: (candidate: ApprovalCandidate) => void | Promise<void>;
  onUndo: (actionId: string) => void | Promise<void>;
}

type SwipeDirection = "right" | "left" | "up" | "down" | null;

function getSwipeDirection(deltaX: number, deltaY: number): SwipeDirection {
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    if (deltaX >= 32) return "right";
    if (deltaX <= -32) return "left";
    return null;
  }

  if (deltaY <= -32) return "up";
  if (deltaY >= 32) return "down";
  return null;
}

function getPreviewLabel(direction: SwipeDirection, kind: ApprovalKind) {
  if (!direction) {
    return null;
  }

  if (direction === "right") {
    return kind === "probe" ? "Approve probe" : "Swipe right: approve";
  }

  if (direction === "left") {
    return kind === "probe" ? "Skip for now" : "Keep question only";
  }

  if (direction === "up") {
    return "Reject candidate";
  }

  return "Undo last action";
}

function createDetailPayload(candidate: ApprovalCandidate): CandidateDetailSubmitPayload {
  return {
    candidate,
    question: candidate.question,
    answer: candidate.answer,
    mode: "create_new",
  };
}

export function CandidateCard({
  candidate,
  kind,
  assets,
  lastActionId,
  onApprove,
  onKeepQuestionOnly,
  onReject,
  onSkipProbe,
  onUndo,
}: CandidateCardProps) {
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const [previewDirection, setPreviewDirection] = useState<SwipeDirection>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const previewLabel = useMemo(
    () => getPreviewLabel(previewDirection, kind),
    [kind, previewDirection],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    startPointRef.current = { x: event.clientX, y: event.clientY };
    setPreviewDirection(null);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!startPointRef.current) {
      return;
    }

    setPreviewDirection(
      getSwipeDirection(
        event.clientX - startPointRef.current.x,
        event.clientY - startPointRef.current.y,
      ),
    );
  };

  const handlePointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!startPointRef.current) {
      return;
    }

    const deltaX = event.clientX - startPointRef.current.x;
    const deltaY = event.clientY - startPointRef.current.y;
    const direction = getSwipeDirection(deltaX, deltaY);
    const dominantDistance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    startPointRef.current = null;
    setPreviewDirection(null);

    if (dominantDistance < 96 || !direction) {
      if (dominantDistance < 12) {
        setDetailOpen(true);
      }
      return;
    }

    if (direction === "right") {
      await onApprove(createDetailPayload(candidate));
      return;
    }

    if (direction === "left") {
      if (kind === "probe") {
        await onSkipProbe(candidate);
      } else {
        await onKeepQuestionOnly({
          candidate,
          question: candidate.question,
          answer: candidate.answer,
          mode: "create_new",
        });
      }
      return;
    }

    if (direction === "up") {
      await onReject(candidate);
      return;
    }

    if (lastActionId) {
      await onUndo(lastActionId);
    }
  };

  return (
    <>
      <Card
        className="overflow-hidden rounded-3xl border-0 shadow-md"
        data-testid="candidate-card"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <Badge variant="secondary">
                {kind === "probe" ? "Probe candidate" : "Anchor candidate"}
              </Badge>
              <button className="text-left" type="button" onClick={() => setDetailOpen(true)}>
                <div className="text-lg font-semibold">{candidate.question}</div>
              </button>
            </div>
            <Badge variant="outline">{candidate.source}</Badge>
          </div>

          <button
            className="block w-full text-left"
            type="button"
            onClick={() => setDetailOpen(true)}
          >
            <p className="text-sm leading-6 text-muted-foreground">
              {candidate.answer ?? "This candidate only keeps the question for now."}
            </p>
          </button>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
            <div>{kind === "probe" ? "Right: approve probe" : "Right: approve"}</div>
            <div>{kind === "probe" ? "Left: skip" : "Left: question only"}</div>
            <div>Up: reject</div>
            <div>Down: undo</div>
          </div>

          {previewLabel && (
            <div className="rounded-2xl bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
              {previewLabel}
            </div>
          )}
        </CardContent>
      </Card>

      <CandidateDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        candidate={candidate}
        kind={kind}
        assets={assets}
        onApprove={async (payload) => {
          await onApprove(payload);
          setDetailOpen(false);
        }}
        onKeepQuestionOnly={async (payload) => {
          await onKeepQuestionOnly(payload);
          setDetailOpen(false);
        }}
      />
    </>
  );
}
