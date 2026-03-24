import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface ChatAvatarProps {
  pubKey: string;
  name?: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
}

const sizeMap = {
  sm: { px: 32, radius: 6, fontSize: "text-xs" },
  md: { px: 44, radius: 10, fontSize: "text-sm" },
  lg: { px: 72, radius: 14, fontSize: "text-xl" },
} as const;

// Predefined set of hues for deterministic avatar colors
const AVATAR_HUES = [0, 30, 60, 120, 180, 210, 240, 270, 300, 330];

function getHueFromPubKey(pubKey: string): number {
  let sum = 0;
  for (let i = 0; i < pubKey.length; i++) {
    sum += pubKey.charCodeAt(i);
  }
  return AVATAR_HUES[sum % AVATAR_HUES.length];
}

function getDisplayChar(pubKey: string, name?: string): string {
  if (name) return name.charAt(0).toUpperCase();
  return pubKey.charAt(0).toUpperCase();
}

export function ChatAvatar({ pubKey, name, src, size = "md", onClick }: ChatAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const isReMi = pubKey === "remi";
  const { px, radius, fontSize } = sizeMap[size];

  const displayText = isReMi ? "Ri" : getDisplayChar(pubKey, name);
  const accessibleName = name ?? pubKey;
  const canShowImage = Boolean(src) && !imageFailed;

  useEffect(() => {
    setImageFailed(false);
  }, [src]);

  const bgStyle: React.CSSProperties = isReMi
    ? { background: "linear-gradient(135deg, #667eea, #764ba2)" }
    : { backgroundColor: `hsl(${getHueFromPubKey(pubKey)}, 55%, 50%)` };

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "inline-flex items-center justify-center font-bold text-white select-none shrink-0",
        fontSize,
        onClick && "cursor-pointer",
      )}
      style={{
        width: px,
        height: px,
        borderRadius: radius,
      }}
      aria-label={onClick && !canShowImage ? accessibleName : undefined}
    >
      {canShowImage ? (
        <img
          src={src}
          alt={accessibleName}
          onError={() => setImageFailed(true)}
          className="h-full w-full object-cover"
          style={{ borderRadius: radius }}
        />
      ) : (
        <div
          className="inline-flex h-full w-full items-center justify-center"
          style={{
            borderRadius: radius,
            ...bgStyle,
          }}
        >
          {displayText}
        </div>
      )}
    </div>
  );
}
