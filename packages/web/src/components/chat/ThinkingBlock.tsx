import { useState } from "react";

interface ThinkingBlockProps {
  narrative: string;
}

export function ThinkingBlock({ narrative }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3 ml-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="text-xs text-muted-foreground italic">
        {expanded ? narrative : `${narrative.slice(0, 60)}...`}
      </div>
    </div>
  );
}
