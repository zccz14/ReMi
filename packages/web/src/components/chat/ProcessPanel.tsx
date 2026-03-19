import type { ChatPhase } from "../../hooks/use-chat";

interface ProcessPanelProps {
  phase: ChatPhase;
  thinkingItems: string[];
}

const PHASE_LABELS: Record<ChatPhase, string> = {
  idle: "Idle",
  bootstrapping: "Bootstrapping",
  extracting: "Extracting",
  recalling: "Recalling",
  detecting: "Detecting",
  generating: "Generating",
};

export function ProcessPanel({ phase, thinkingItems }: ProcessPanelProps) {
  if (phase === "idle" && thinkingItems.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Process</span>
        <span className="rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {PHASE_LABELS[phase]}
        </span>
      </div>
      {thinkingItems.length > 0 && (
        <ul className="space-y-1">
          {thinkingItems.map((item, idx) => (
            <li key={`${idx}-${item.slice(0, 16)}`} className="text-xs text-muted-foreground">
              • {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
