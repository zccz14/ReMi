import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FullScreenLayout } from "../components/layout/FullScreenLayout";
import { useAuth } from "../hooks/use-auth";
import { useReadingSession } from "../hooks/use-reading-session";
import { createReadingApi, persistReadingApprovedAnchors } from "../lib/reading-api";
import { trackReadingEvent } from "../lib/reading-telemetry";
import { getReadingLengthState, type ReadingRoundItem } from "../lib/reading-session";

export function ReadingPage() {
  const { t } = useTranslation();
  const { apiClient } = useAuth();
  const readingApi = useMemo(() => createReadingApi(apiClient), [apiClient]);
  const persistApproved = useCallback(
    (anchors: Parameters<typeof persistReadingApprovedAnchors>[1]) =>
      persistReadingApprovedAnchors(apiClient, anchors),
    [apiClient],
  );
  const reading = useReadingSession({
    readingApi,
    persistApproved,
  });
  const [text, setText] = useState("");
  const { count: charCount, isShort: showShortHint, isTooLong } = getReadingLengthState(text);
  const hasInput = text.trim().length > 0;

  useEffect(() => {
    trackReadingEvent("reading.page_viewed", {});
  }, []);

  const handleStart = async () => {
    if (isTooLong || !text.trim()) return;
    try {
      await reading.startSession({ text });
    } catch {
      toast.error(t("common.error"));
    }
  };

  if (!reading.session) {
    return (
      <FullScreenLayout title={t("reading.title")}>
        <div className="p-4 space-y-4">
          <p className="text-sm text-muted-foreground">{t("reading.description")}</p>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="reading-input">
              {t("reading.inputLabel")}
            </label>
            <Textarea
              id="reading-input"
              aria-label={t("reading.inputLabel")}
              rows={14}
              className="max-h-[400px] overflow-y-auto"
              style={{ maxHeight: 400 }}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              {t("reading.charCount", { count: charCount })}
            </div>
            {showShortHint ? (
              <p className="text-sm text-muted-foreground">{t("reading.shortHint")}</p>
            ) : null}
            {isTooLong ? <p className="text-sm text-destructive">{t("reading.tooLong")}</p> : null}
          </div>
          <Button
            className="w-full"
            disabled={isTooLong || reading.isStarting || !hasInput}
            onClick={() => void handleStart()}
          >
            {reading.isStarting ? t("reading.starting") : t("reading.start")}
          </Button>
        </div>
      </FullScreenLayout>
    );
  }

  if (reading.session.stage === "closed") {
    return (
      <FullScreenLayout title={t("reading.title")}>
        <div className="p-4">
          <Card>
            <CardContent className="space-y-3">
              <p className="font-medium">{t("reading.closedTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("reading.closedDescription")}</p>
              <Button type="button" onClick={() => reading.resetSession()}>
                {t("reading.startNew")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </FullScreenLayout>
    );
  }

  if (reading.session.stage === "summary" && reading.session.summary) {
    const summary = reading.session.summary;
    return (
      <FullScreenLayout title={t("reading.title")}>
        <div className="p-4 space-y-4">
          <Card>
            <CardContent className="space-y-3">
              <h2 className="font-medium">{t("reading.summaryTitle")}</h2>
              <div className="flex flex-wrap gap-2">
                {summary.coveredTopics.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3">
              <p className="font-medium">{t("reading.missingTopicsTitle")}</p>
              {summary.shouldSuggestStop ? (
                <p className="text-sm text-muted-foreground">{t("reading.suggestStop")}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {summary.missingTopics.map((topic) => {
                  const selected = summary.selectedMissingTopics.includes(topic);
                  return (
                    <Button
                      key={topic}
                      type="button"
                      variant={selected ? "default" : "outline"}
                      size="sm"
                      onClick={() => reading.toggleMissingTopic(topic)}
                    >
                      {topic}
                    </Button>
                  );
                })}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="reading-extra-focus">
                  {t("reading.extraFocusLabel")}
                </label>
                <Input
                  id="reading-extra-focus"
                  aria-label={t("reading.extraFocusLabel")}
                  value={summary.extraFocus}
                  onChange={(event) => reading.setExtraFocus(event.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={reading.isContinuing}
                  onClick={() => {
                    void reading.continueToNextRound().catch(() => {
                      toast.error(t("common.error"));
                    });
                  }}
                >
                  {t("reading.keepDigging")}
                </Button>
                <Button
                  className="flex-1"
                  variant="secondary"
                  onClick={() => reading.closeSession()}
                >
                  {t("reading.alreadyEnough")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </FullScreenLayout>
    );
  }

  const groups = (() => {
    const map = new Map<string, { label: string; items: ReadingRoundItem[] }>();
    for (const item of reading.session.currentRound.items) {
      const group = map.get(item.themeId) ?? { label: item.themeLabel, items: [] };
      group.items.push(item);
      map.set(item.themeId, group);
    }
    return Array.from(map.entries());
  })();

  if (reading.session.currentRound.items.length === 0) {
    return (
      <FullScreenLayout title={t("reading.title")}>
        <div className="p-4 space-y-4">
          <Card>
            <CardContent className="space-y-3">
              <p className="font-medium">{t("reading.lowYieldTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("reading.lowYieldDescription")}</p>
              <Button onClick={() => reading.closeSession()}>{t("reading.alreadyEnough")}</Button>
            </CardContent>
          </Card>
        </div>
      </FullScreenLayout>
    );
  }

  return (
    <FullScreenLayout title={t("reading.title")}>
      <div className="flex h-full flex-col">
        <div className="p-4 text-sm text-muted-foreground">
          {t("reading.progress", reading.progress)}
        </div>
        <div className="flex-1 overflow-y-auto px-4 space-y-4 pb-4">
          {groups.map(([themeId, group]) => (
            <div key={themeId} className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">{group.label}</div>
              {group.items.map((item) => {
                const showSource = item.isSourceOpen;
                return (
                  <Card key={item.id}>
                    <CardContent className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="font-medium">{item.question}</div>
                        {item.origin === "review" ? (
                          <Badge variant="outline">{t("reading.reviewBadge")}</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">{item.answer}</p>
                      <div className="flex flex-wrap gap-2">
                        {(
                          [
                            ["approved", t("reading.approved")],
                            ["question_invalid", t("reading.questionInvalid")],
                            ["answer_invalid", t("reading.answerInvalid")],
                          ] as const
                        ).map(([value, label]) => (
                          <Button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={item.selection === value}
                            variant={item.selection === value ? "default" : "outline"}
                            size="sm"
                            onClick={() => reading.selectItem(item.id, value)}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          reading.toggleSource(item.id);
                          if (!item.sourceSnippet) {
                            trackReadingEvent("reading.source_unavailable", { itemId: item.id });
                          }
                        }}
                      >
                        {t("reading.viewSource")}
                      </Button>
                      {showSource ? (
                        item.sourceSnippet ? (
                          <p className="rounded-lg bg-muted p-3 text-sm">{item.sourceSnippet}</p>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {t("reading.sourceUnavailable")}
                          </p>
                        )
                      ) : null}
                      {item.selection === "answer_invalid" ? (
                        <Textarea
                          placeholder={t("reading.correctionHintPlaceholder")}
                          rows={3}
                          value={item.correctionHint}
                          onChange={(event) =>
                            reading.setCorrectionHint(item.id, event.target.value)
                          }
                        />
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ))}
        </div>
        <div className="border-t p-4 space-y-2">
          <Button
            className="w-full"
            disabled={!reading.progress.complete || reading.isSubmitting}
            onClick={() => {
              void reading.submitRound().catch(() => {
                toast.error(t("common.error"));
              });
            }}
          >
            {t("reading.submitRound")}
          </Button>
          {!reading.progress.complete ? (
            <p className="text-xs text-muted-foreground">{t("reading.submitHint")}</p>
          ) : null}
        </div>
      </div>
    </FullScreenLayout>
  );
}
