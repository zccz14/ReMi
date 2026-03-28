import { useCallback, useMemo, useRef, useState } from "react";
import i18n from "../lib/i18n";
import {
  normalizeMissingTopics,
  type GenerateNextRoundInput,
  readingApi,
  type ReadingApi,
  type StartReadingInput,
} from "../lib/reading-api";
import { trackReadingError, trackReadingEvent } from "../lib/reading-telemetry";
import {
  cloneRoundItems,
  countAnsweredItems,
  hasAnsweredAllItems,
  mapApprovedAnchors,
  type ReadingLocale,
  READING_SESSION_STORAGE_KEY,
  restoreReadingSession,
  serializeReadingSession,
  splitRoundItems,
  type ReadingSelection,
  type ReadingSession,
  type ReadingSummaryState,
} from "../lib/reading-session";

interface UseReadingSessionDeps {
  readingApi?: ReadingApi;
  persistApproved?: (anchors: ReturnType<typeof mapApprovedAnchors>) => Promise<void> | void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
}

function updateSession(
  storage: Pick<Storage, "setItem" | "removeItem">,
  session: ReadingSession | null,
) {
  if (!session) {
    storage.removeItem(READING_SESSION_STORAGE_KEY);
    return;
  }

  storage.setItem(READING_SESSION_STORAGE_KEY, serializeReadingSession(session));
}

export function useReadingSession(deps: UseReadingSessionDeps = {}) {
  const api = deps.readingApi ?? readingApi;
  const storage = deps.storage ?? window.localStorage;
  const now = deps.now ?? (() => Date.now());
  const persistApproved = deps.persistApproved ?? (() => undefined);
  const resolveLocale = useCallback<() => ReadingLocale>(
    () => ((i18n.resolvedLanguage ?? i18n.language)?.startsWith("en") ? "en" : "zh"),
    [],
  );
  const submittingRef = useRef(false);
  const continuingRef = useRef(false);
  const startingRef = useRef(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [session, setSession] = useState<ReadingSession | null>(() => {
    const raw = storage.getItem(READING_SESSION_STORAGE_KEY);
    const restored = restoreReadingSession(raw, now());
    if (raw && !restored) {
      storage.removeItem(READING_SESSION_STORAGE_KEY);
    }
    return restored;
  });

  const persistSession = useCallback(
    (next: ReadingSession | null) => {
      updateSession(storage, next);
      setSession(next);
    },
    [storage],
  );

  const hydrate = useCallback(
    (next: ReadingSession | null) => {
      persistSession(next);
    },
    [persistSession],
  );

  const startSession = useCallback(
    async ({ text }: StartReadingInput) => {
      if (startingRef.current) return;
      startingRef.current = true;
      setIsStarting(true);
      try {
        const locale = resolveLocale();
        const generated = await api.generateFirstRound({ text, locale });
        const timestamp = now();
        const next: ReadingSession = {
          locale,
          status: "active",
          stage: "questionnaire",
          text,
          createdAt: timestamp,
          updatedAt: timestamp,
          currentRound: {
            index: 1,
            items: cloneRoundItems(generated.items),
          },
          invalidQuestions: [],
          candidatePool: generated.candidatePool.filter((item) => item.origin !== "review"),
          reviewQueue: generated.candidatePool.filter((item) => item.origin === "review"),
          approvedAnchors: [],
          submittedRounds: [],
          summary: null,
        };
        persistSession(next);
        trackReadingEvent("reading.session_started", {
          roundSize: next.currentRound.items.length,
          candidatePoolSize: next.candidatePool.length,
        });
      } catch (error) {
        trackReadingError("start_session", error);
        throw error;
      } finally {
        startingRef.current = false;
        setIsStarting(false);
      }
    },
    [api, now, persistSession, resolveLocale],
  );

  const patchSession = useCallback(
    (mutate: (current: ReadingSession) => ReadingSession) => {
      if (!session) return;
      const next = mutate({ ...session, updatedAt: now() });
      persistSession(next);
    },
    [now, persistSession, session],
  );

  const selectItem = useCallback(
    (itemId: string, selection: Exclude<ReadingSelection, null>) => {
      patchSession((current) => ({
        ...current,
        currentRound: {
          ...current.currentRound,
          items: current.currentRound.items.map((item) =>
            item.id === itemId ? { ...item, selection } : item,
          ),
        },
      }));
    },
    [patchSession],
  );

  const setCorrectionHint = useCallback(
    (itemId: string, correctionHint: string) => {
      patchSession((current) => ({
        ...current,
        currentRound: {
          ...current.currentRound,
          items: current.currentRound.items.map((item) =>
            item.id === itemId ? { ...item, correctionHint } : item,
          ),
        },
      }));
    },
    [patchSession],
  );

  const toggleSource = useCallback(
    (itemId: string) => {
      patchSession((current) => ({
        ...current,
        currentRound: {
          ...current.currentRound,
          items: current.currentRound.items.map((item) =>
            item.id === itemId ? { ...item, isSourceOpen: !item.isSourceOpen } : item,
          ),
        },
      }));
    },
    [patchSession],
  );

  const submitRound = useCallback(async () => {
    if (!session || session.stage !== "questionnaire") {
      return false;
    }

    if (submittingRef.current) {
      return false;
    }

    if (!hasAnsweredAllItems(session.currentRound.items)) {
      return false;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    let storedNextSession = false;
    try {
      const split = splitRoundItems(session.currentRound.items);
      const approved = mapApprovedAnchors(split.approved);
      const invalidQuestions = Array.from(
        new Set([
          ...session.invalidQuestions,
          ...split.questionInvalid.map((item) => item.question),
        ]),
      );

      const summaryResult = await api.summarizeRound({
        locale: session.locale,
        text: session.text,
        approvedAnchors: [...session.approvedAnchors, ...approved],
        currentRoundItems: split.approved,
        invalidQuestions,
      });
      const coveredTopics = Array.from(
        new Set(summaryResult.coveredTopics.map((topic) => topic.trim()).filter(Boolean)),
      );

      const nextSummary: ReadingSummaryState = {
        coveredTopics,
        missingTopics: normalizeMissingTopics(
          summaryResult.missingTopics,
          coveredTopics,
          session.locale,
        ),
        selectedMissingTopics: [],
        extraFocus: "",
        invalidQuestions,
        shouldSuggestStop:
          session.submittedRounds.length >= 1 &&
          session.reviewQueue.length + split.answerInvalid.length + session.candidatePool.length <=
            2,
      };

      const nextSession: ReadingSession = {
        ...session,
        updatedAt: now(),
        stage: "summary",
        approvedAnchors: [...session.approvedAnchors, ...approved],
        reviewQueue: [
          ...session.reviewQueue,
          ...split.answerInvalid.map((item) => ({
            ...item,
            origin: "review" as const,
            reviewHint: item.correctionHint.trim() || item.reviewHint,
          })),
        ],
        submittedRounds: [
          ...session.submittedRounds,
          {
            roundIndex: session.currentRound.index,
            approvedIds: split.approved.map((item) => item.id),
            questionInvalidIds: split.questionInvalid.map((item) => item.id),
            answerInvalidIds: split.answerInvalid.map((item) => item.id),
          },
        ],
        summary: nextSummary,
        invalidQuestions,
      };

      updateSession(storage, nextSession);
      storedNextSession = true;
      await persistApproved(approved);
      setSession(nextSession);
      trackReadingEvent("reading.round_submitted", {
        approved: split.approved.length,
        questionInvalid: split.questionInvalid.length,
        answerInvalid: split.answerInvalid.length,
      });
      return true;
    } catch (error) {
      if (storedNextSession) {
        updateSession(storage, session);
      }
      trackReadingError("submit_round", error);
      throw error;
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [api, now, persistApproved, session, storage]);

  const toggleMissingTopic = useCallback(
    (topic: string) => {
      patchSession((current) => {
        if (!current.summary) return current;
        const exists = current.summary.selectedMissingTopics.includes(topic);
        return {
          ...current,
          summary: {
            ...current.summary,
            selectedMissingTopics: exists
              ? current.summary.selectedMissingTopics.filter((item) => item !== topic)
              : [...current.summary.selectedMissingTopics, topic],
          },
        };
      });
    },
    [patchSession],
  );

  const setExtraFocus = useCallback(
    (extraFocus: string) => {
      patchSession((current) => {
        if (!current.summary) return current;
        return {
          ...current,
          summary: { ...current.summary, extraFocus },
        };
      });
    },
    [patchSession],
  );

  const continueToNextRound = useCallback(async () => {
    if (!session || session.stage !== "summary" || !session.summary) {
      return false;
    }

    if (continuingRef.current) {
      return false;
    }

    continuingRef.current = true;
    setIsContinuing(true);
    try {
      const input: GenerateNextRoundInput = {
        locale: session.locale,
        text: session.text,
        approvedAnchors: session.approvedAnchors,
        reviewQueue: session.reviewQueue,
        candidatePool: session.candidatePool,
        selectedMissingTopics: session.summary.selectedMissingTopics,
        extraFocus: session.summary.extraFocus,
        invalidQuestions: session.invalidQuestions,
      };

      const generated = await api.generateNextRound(input);
      const nextSession: ReadingSession = {
        ...session,
        updatedAt: now(),
        stage: "questionnaire",
        currentRound: {
          index: session.currentRound.index + 1,
          items: cloneRoundItems(generated.items),
        },
        candidatePool: generated.candidatePool.filter((item) => item.origin !== "review"),
        reviewQueue: generated.candidatePool.filter((item) => item.origin === "review"),
        summary: null,
      };

      persistSession(nextSession);
      trackReadingEvent("reading.next_round_requested", {
        selectedMissingTopics: session.summary.selectedMissingTopics.length,
        nextRoundSize: nextSession.currentRound.items.length,
      });
      return true;
    } catch (error) {
      trackReadingError("continue_next_round", error);
      throw error;
    } finally {
      continuingRef.current = false;
      setIsContinuing(false);
    }
  }, [api, now, persistSession, session]);

  const closeSession = useCallback(() => {
    if (!session) return;
    persistSession({
      ...session,
      updatedAt: now(),
      status: "closed",
      stage: "closed",
    });
    trackReadingEvent("reading.session_closed", {
      roundIndex: session.currentRound.index,
      submittedRounds: session.submittedRounds.length,
    });
  }, [now, persistSession, session]);

  const resetSession = useCallback(() => {
    persistSession(null);
  }, [persistSession]);

  const progress = useMemo(() => {
    if (!session) return { answered: 0, total: 0, complete: false };
    const answered = countAnsweredItems(session.currentRound.items);
    return {
      answered,
      total: session.currentRound.items.length,
      complete: hasAnsweredAllItems(session.currentRound.items),
    };
  }, [session]);

  return {
    session,
    progress,
    hydrate,
    startSession,
    selectItem,
    setCorrectionHint,
    toggleSource,
    submitRound,
    toggleMissingTopic,
    setExtraFocus,
    continueToNextRound,
    closeSession,
    resetSession,
    isStarting,
    isSubmitting,
    isContinuing,
  };
}
