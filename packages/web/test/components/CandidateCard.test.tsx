// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderWithProviders, screen } from "../helpers/test-utils";
import { CandidateCard } from "../../src/components/approval/CandidateCard";
import type { ApprovalCandidate } from "../../src/lib/approval-api";

const anchorCandidate: ApprovalCandidate = {
  id: "candidate-1",
  ownerKey: "owner-key",
  question: "What matters most?",
  answer: "Trust is the floor.",
  source: "reading",
  sourceRef: "reading:1",
  sourceSnapshot: { excerpt: "Trust is the floor." },
  createdAt: 100,
  kind: "anchor",
};

const existingAsset = {
  id: "asset-1",
  question: "What matters most?",
  answer: "Trust",
  updatedAt: 42,
};

function swipeCard(direction: { startX?: number; startY?: number; endX: number; endY: number }) {
  const cards = screen.getAllByTestId("candidate-card");
  const card = cards[cards.length - 1]!;
  fireEvent.pointerDown(card, { clientX: direction.startX ?? 0, clientY: direction.startY ?? 0 });
  fireEvent.pointerMove(card, { clientX: direction.endX, clientY: direction.endY });
  fireEvent.pointerUp(card, { clientX: direction.endX, clientY: direction.endY });
}

afterEach(() => {
  cleanup();
});

describe("CandidateCard", () => {
  it("shows semantic preview text before releasing swipe", () => {
    renderWithProviders(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[]}
        lastActionId="action-1"
        onApprove={vi.fn()}
        onKeepQuestionOnly={vi.fn()}
        onReject={vi.fn()}
        onSkipProbe={vi.fn()}
        onUndo={vi.fn()}
      />,
    );

    const card = screen.getByTestId("candidate-card");
    fireEvent.pointerDown(card, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(card, { clientX: 48, clientY: 0 });

    expect(screen.getByText(/Swipe right: approve|右滑：认可/i)).toBeInTheDocument();
  });

  it("maps anchor tab swipe directions to approve, question-only, reject, and undo", () => {
    const onApprove = vi.fn();
    const onKeepQuestionOnly = vi.fn();
    const onReject = vi.fn();
    const onUndo = vi.fn();

    const { rerender } = renderWithProviders(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[]}
        lastActionId="action-1"
        onApprove={onApprove}
        onKeepQuestionOnly={onKeepQuestionOnly}
        onReject={onReject}
        onSkipProbe={vi.fn()}
        onUndo={onUndo}
      />,
    );

    swipeCard({ endX: 120, endY: 0 });
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[]}
        lastActionId="action-1"
        onApprove={onApprove}
        onKeepQuestionOnly={onKeepQuestionOnly}
        onReject={onReject}
        onSkipProbe={vi.fn()}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: -120, endY: 0 });
    expect(onKeepQuestionOnly).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[]}
        lastActionId="action-1"
        onApprove={onApprove}
        onKeepQuestionOnly={onKeepQuestionOnly}
        onReject={onReject}
        onSkipProbe={vi.fn()}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: 0, endY: -120 });
    expect(onReject).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[]}
        lastActionId="action-1"
        onApprove={onApprove}
        onKeepQuestionOnly={onKeepQuestionOnly}
        onReject={onReject}
        onSkipProbe={vi.fn()}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: 0, endY: 120 });
    expect(onUndo).toHaveBeenCalledWith("action-1");
  });

  it("maps probe tab swipe directions to approve, skip, reject, and undo", () => {
    const onApprove = vi.fn();
    const onSkipProbe = vi.fn();
    const onReject = vi.fn();
    const onUndo = vi.fn();
    const probeCandidate = {
      ...anchorCandidate,
      id: "candidate-2",
      answer: null,
      kind: "probe" as const,
    };

    const { rerender } = renderWithProviders(
      <CandidateCard
        candidate={probeCandidate}
        kind="probe"
        assets={[]}
        lastActionId="action-2"
        onApprove={onApprove}
        onKeepQuestionOnly={vi.fn()}
        onReject={onReject}
        onSkipProbe={onSkipProbe}
        onUndo={onUndo}
      />,
    );

    swipeCard({ endX: 120, endY: 0 });
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={probeCandidate}
        kind="probe"
        assets={[]}
        lastActionId="action-2"
        onApprove={onApprove}
        onKeepQuestionOnly={vi.fn()}
        onReject={onReject}
        onSkipProbe={onSkipProbe}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: -120, endY: 0 });
    expect(onSkipProbe).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={probeCandidate}
        kind="probe"
        assets={[]}
        lastActionId="action-2"
        onApprove={onApprove}
        onKeepQuestionOnly={vi.fn()}
        onReject={onReject}
        onSkipProbe={onSkipProbe}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: 0, endY: -120 });
    expect(onReject).toHaveBeenCalledTimes(1);

    rerender(
      <CandidateCard
        candidate={probeCandidate}
        kind="probe"
        assets={[]}
        lastActionId="action-2"
        onApprove={onApprove}
        onKeepQuestionOnly={vi.fn()}
        onReject={onReject}
        onSkipProbe={onSkipProbe}
        onUndo={onUndo}
      />,
    );
    swipeCard({ endX: 0, endY: 120 });
    expect(onUndo).toHaveBeenCalledWith("action-2");
  });

  it("opens detail sheet on tap for source context, micro-edit, and update-existing flow", async () => {
    const onApprove = vi.fn();

    renderWithProviders(
      <CandidateCard
        candidate={anchorCandidate}
        kind="anchor"
        assets={[existingAsset]}
        lastActionId="action-1"
        onApprove={onApprove}
        onKeepQuestionOnly={vi.fn()}
        onReject={vi.fn()}
        onSkipProbe={vi.fn()}
        onUndo={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText("What matters most?")[0]!);

    expect(screen.getAllByText("Trust is the floor.").length).toBeGreaterThan(0);

    const questionInput = screen.getByLabelText(/Question/i);
    const answerInput = screen.getByLabelText(/Answer/i);
    fireEvent.change(questionInput, { target: { value: "What still matters most?" } });
    fireEvent.change(answerInput, { target: { value: "Trust after pressure." } });

    fireEvent.click(screen.getByLabelText(/Update existing/i));
    fireEvent.change(screen.getByLabelText(/Existing asset/i), { target: { value: "asset-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Approve candidate/i }));

    expect(onApprove).toHaveBeenCalledWith({
      candidate: anchorCandidate,
      question: "What still matters most?",
      answer: "Trust after pressure.",
      mode: "update_existing",
      targetAssetId: "asset-1",
      targetUpdatedAt: 42,
    });
  });
});
