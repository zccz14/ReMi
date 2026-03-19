import { useState, type KeyboardEvent } from "react";

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [value, setValue] = useState("");

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-2 p-3 border-t bg-white">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm min-h-[40px] max-h-[120px]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Type a message..."}
        disabled={disabled}
        rows={1}
      />
      <button
        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
        onClick={handleSend}
        disabled={disabled || !value.trim()}
      >
        Send
      </button>
    </div>
  );
}
