import { useEffect, useRef, useState } from "react";
import { MicOff, X } from "lucide-react";

type ConvLike = {
  isSpeaking?: boolean;
  status?: string;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
};

type Props = {
  open: boolean;
  conversation: ConvLike;
  connecting: boolean;
  onStop: () => void;
  lastUserText?: string;
  lastAssistantText?: string;
};

export function VoiceOverlay({
  open,
  conversation,
  connecting,
  onStop,
  lastUserText,
  lastAssistantText,
}: Props) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      try {
        const speaking = !!conversation.isSpeaking;
        const v = speaking
          ? conversation.getOutputVolume?.() ?? 0
          : conversation.getInputVolume?.() ?? 0;
        // smooth + ease
        setLevel((prev) => prev * 0.7 + Math.min(1, Math.max(0, v)) * 0.3);
      } catch {
        /* noop */
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [open, conversation]);

  if (!open) return null;

  const speaking = !!conversation.isSpeaking;
  const stateLabel = connecting
    ? "Connecting…"
    : speaking
    ? "Speaking"
    : "Listening";

  const scale = 1 + level * 0.35;
  const glow = 30 + level * 80;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-background/95 backdrop-blur-xl px-6 py-10 animate-in fade-in duration-200">
      {/* Top: state + close */}
      <div className="w-full max-w-md flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              connecting
                ? "bg-muted-foreground animate-pulse"
                : speaking
                ? "bg-accent animate-pulse"
                : "bg-primary animate-pulse"
            }`}
          />
          <span className="text-sm font-medium text-foreground">{stateLabel}</span>
        </div>
        <button
          type="button"
          onClick={onStop}
          className="p-2 rounded-full hover:bg-secondary text-muted-foreground"
          aria-label="Close voice"
        >
          <X size={20} />
        </button>
      </div>

      {/* Center: reactive orb */}
      <div className="flex-1 flex items-center justify-center w-full">
        <div className="relative flex items-center justify-center">
          {/* outer rings */}
          <div
            className="absolute rounded-full border border-primary/20"
            style={{
              width: `${260 + level * 60}px`,
              height: `${260 + level * 60}px`,
              transition: "width 120ms ease-out, height 120ms ease-out",
            }}
          />
          <div
            className="absolute rounded-full border border-accent/20"
            style={{
              width: `${320 + level * 100}px`,
              height: `${320 + level * 100}px`,
              transition: "width 160ms ease-out, height 160ms ease-out",
            }}
          />
          {/* orb */}
          <div
            className="rounded-full"
            style={{
              width: "180px",
              height: "180px",
              transform: `scale(${scale})`,
              transition: "transform 80ms ease-out",
              background: speaking
                ? "radial-gradient(circle at 30% 30%, hsl(var(--accent)) 0%, hsl(var(--primary)) 70%)"
                : "radial-gradient(circle at 30% 30%, hsl(var(--primary)) 0%, hsl(var(--accent)) 90%)",
              boxShadow: `0 0 ${glow}px hsl(var(--primary) / 0.45), 0 0 ${glow * 0.6}px hsl(var(--accent) / 0.35)`,
            }}
          />
        </div>
      </div>

      {/* Transcript snippets */}
      <div className="w-full max-w-md mb-4 min-h-[60px] text-center space-y-1">
        {lastUserText && (
          <p className="text-xs text-muted-foreground truncate">
            You: {lastUserText}
          </p>
        )}
        {lastAssistantText && (
          <p className="text-sm text-foreground line-clamp-2">{lastAssistantText}</p>
        )}
      </div>

      {/* Bottom: hint + stop */}
      <div className="w-full max-w-md flex flex-col items-center gap-3">
        <p className="text-xs text-muted-foreground text-center">
          Just start talking — speak to interrupt anytime
        </p>
        <button
          type="button"
          onClick={onStop}
          className="w-16 h-16 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-lg hover:scale-105 transition active:scale-95"
          aria-label="End voice"
        >
          <MicOff size={26} />
        </button>
        <p className="text-[11px] text-muted-foreground">Tap to end</p>
      </div>
    </div>
  );
}
