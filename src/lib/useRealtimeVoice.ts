import { useCallback, useEffect, useRef, useState } from "react";

// ------- Types -------

type ToolResult = string | Record<string, unknown>;
export type ClientTool = (
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

export type RealtimeToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeMessage = {
  source: "user" | "ai";
  message: string;
  event_id?: string;
};

export type RealtimeAssistantDelta = {
  text: string;
  kind: "start" | "delta" | "stop";
  event_id?: string;
};

export type RealtimeUsage = {
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  responseId?: string;
};

export type UseRealtimeVoiceOptions = {
  clientTools?: Record<string, ClientTool>;
  toolDefs?: RealtimeToolDef[];
  onConnect?: () => void;
  onDisconnect?: (details?: { reason?: string; message?: string }) => void;
  onError?: (message: string) => void;
  onMessage?: (m: RealtimeMessage) => void;
  onAssistantDelta?: (part: RealtimeAssistantDelta) => void;
  onUsage?: (u: RealtimeUsage) => void;
};

export type RealtimeStatus = "disconnected" | "connecting" | "connected";

// ------- Hook -------

export function useRealtimeVoice(options: UseRealtimeVoiceOptions) {
  const [status, setStatus] = useState<RealtimeStatus>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const assistantAccumRef = useRef<Map<string, string>>(new Map());
  const activeResponseRef = useRef(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cleanup = useCallback(() => {
    try { dcRef.current?.close(); } catch (err) { console.warn(err); }
    dcRef.current = null;
    try {
      pcRef.current?.getSenders().forEach((s) => {
        try { s.track?.stop(); } catch (e) { console.warn(e); }
      });
      pcRef.current?.close();
    } catch (err) { console.warn(err); }
    pcRef.current = null;
    try { localStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch (err) { console.warn(err); }
    localStreamRef.current = null;
    if (audioElRef.current) {
      try { audioElRef.current.srcObject = null; } catch (err) { console.warn(err); }
    }
    assistantAccumRef.current.clear();
    setIsSpeaking(false);
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.warn("send event failed", err);
      return false;
    }
  }, []);

  const handleServerEvent = useCallback(
    async (msg: Record<string, unknown>) => {
      const type = msg?.type as string | undefined;
      const opts = optionsRef.current;
      if (!type) return;

      if (type === "error") {
        const err = (msg.error as { message?: string } | undefined)?.message ?? "Realtime error";
        // Swallow benign cancel-with-no-active-response errors — they happen
        // when the user (or our code) issues response.cancel between turns.
        if (/no active response/i.test(err) || /cancellation failed/i.test(err)) {
          activeResponseRef.current = false;
          return;
        }
        opts.onError?.(err);
        return;
      }

      if (type === "response.created") {
        activeResponseRef.current = true;
        return;
      }

      // User speech transcription complete.
      if (
        type === "conversation.item.input_audio_transcription.completed" ||
        type === "conversation.item.input_audio_transcription.done"
      ) {
        const text = String(msg.transcript ?? "").trim();
        if (text) {
          opts.onMessage?.({ source: "user", message: text, event_id: String(msg.item_id ?? "") });
        }
        return;
      }

      // Assistant transcript streaming.
      if (
        type === "response.audio_transcript.delta" ||
        type === "response.output_audio_transcript.delta"
      ) {
        const responseId = String(msg.response_id ?? "");
        const delta = String(msg.delta ?? "");
        const cur = assistantAccumRef.current.get(responseId) ?? "";
        const kind: "start" | "delta" = cur === "" ? "start" : "delta";
        assistantAccumRef.current.set(responseId, cur + delta);
        setIsSpeaking(true);
        opts.onAssistantDelta?.({ text: delta, kind, event_id: responseId });
        return;
      }
      if (
        type === "response.audio_transcript.done" ||
        type === "response.output_audio_transcript.done"
      ) {
        const responseId = String(msg.response_id ?? "");
        const full = String(msg.transcript ?? assistantAccumRef.current.get(responseId) ?? "").trim();
        assistantAccumRef.current.delete(responseId);
        opts.onAssistantDelta?.({ text: "", kind: "stop", event_id: responseId });
        if (full) {
          opts.onMessage?.({ source: "ai", message: full, event_id: responseId });
        }
        return;
      }

      if (type === "output_audio_buffer.started" || type === "response.output_audio.delta") {
        setIsSpeaking(true);
        return;
      }
      if (
        type === "output_audio_buffer.stopped" ||
        type === "response.output_audio.done" ||
        type === "response.done"
      ) {
        setIsSpeaking(false);
        if (type === "response.done") {
          activeResponseRef.current = false;
          // Extract token usage for spend tracking.
          const response = msg.response as
            | {
                id?: string;
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_token_details?: { audio_tokens?: number; text_tokens?: number };
                  output_token_details?: { audio_tokens?: number; text_tokens?: number };
                };
              }
            | undefined;
          const usage = response?.usage;
          if (usage && opts.onUsage) {
            const inAudio = usage.input_token_details?.audio_tokens ?? 0;
            const outAudio = usage.output_token_details?.audio_tokens ?? 0;
            const inText = usage.input_token_details?.text_tokens ??
              Math.max(0, (usage.input_tokens ?? 0) - inAudio);
            const outText = usage.output_token_details?.text_tokens ??
              Math.max(0, (usage.output_tokens ?? 0) - outAudio);
            try {
              opts.onUsage({
                inputAudioTokens: inAudio,
                outputAudioTokens: outAudio,
                inputTextTokens: inText,
                outputTextTokens: outText,
                responseId: response?.id,
              });
            } catch (err) {
              console.warn("onUsage handler failed", err);
            }
          }
        }
        return;
      }

      // Function calls.
      if (type === "response.function_call_arguments.done") {
        const name = String(msg.name ?? "");
        const callId = String(msg.call_id ?? "");
        const argsRaw = String(msg.arguments ?? "");
        const tool = optionsRef.current.clientTools?.[name];
        let output = "";
        if (!tool) {
          output = JSON.stringify({ error: `Unknown tool: ${name}` });
        } else {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(argsRaw || "{}"); } catch { parsed = {}; }
          let shouldCreateResponse = true;
          try {
            const r = await tool(parsed);
            shouldCreateResponse = !(typeof r === "object" && r !== null && "shown_to_user" in r);
            output = typeof r === "string" ? r : JSON.stringify(r);
          } catch (err) {
            output = JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
          }
          sendEvent({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
          });
          if (shouldCreateResponse) sendEvent({ type: "response.create" });
          return;
        }
        sendEvent({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        });
        sendEvent({ type: "response.create" });
        return;
      }
    },
    [sendEvent],
  );

  const startSession = useCallback(
    async (opts: { clientSecret: string; model: string; instructions?: string; microphoneStream?: MediaStream }) => {
      if (status === "connecting" || status === "connected") return;
      setStatus("connecting");
      try {
        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        let audioEl = audioElRef.current;
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.autoplay = true;
          audioEl.setAttribute("playsinline", "true");
          audioElRef.current = audioEl;
        }
        pc.ontrack = (e) => {
          if (audioEl && e.streams[0]) audioEl.srcObject = e.streams[0];
        };

        const stream = opts.microphoneStream ?? await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;

        dc.onopen = () => {
          const tools = optionsRef.current.toolDefs ?? [];
          sendEvent({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: opts.instructions ?? "",
              audio: {
                input: {
                  transcription: { model: "whisper-1" },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 700,
                  },
                },
              },
              tools,
              tool_choice: tools.length > 0 ? "auto" : "none",
            },
          });
          setStatus("connected");
          optionsRef.current.onConnect?.();
        };

        dc.onmessage = async (e) => {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(e.data); } catch { return; }
          if (parsed) await handleServerEvent(parsed);
        };

        dc.onclose = () => {
          if (status !== "disconnected") {
            optionsRef.current.onDisconnect?.({ reason: "closed" });
          }
          setStatus("disconnected");
          cleanup();
        };

        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          if (st === "failed" || st === "disconnected" || st === "closed") {
            optionsRef.current.onDisconnect?.({ reason: st });
            setStatus("disconnected");
            cleanup();
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${opts.clientSecret}`,
            "Content-Type": "application/sdp",
          },
        });
        if (!sdpRes.ok) {
          const t = await sdpRes.text().catch(() => "");
          throw new Error(`SDP exchange failed (${sdpRes.status}): ${t.slice(0, 200)}`);
        }
        const answerSdp = await sdpRes.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (err) {
        cleanup();
        setStatus("disconnected");
        const msg = err instanceof Error ? err.message : String(err);
        optionsRef.current.onError?.(msg);
        throw err;
      }
    },
    [cleanup, handleServerEvent, sendEvent, status],
  );

  const endSession = useCallback(async () => {
    cleanup();
    setStatus("disconnected");
  }, [cleanup]);

  const sendUserMessage = useCallback(
    (text: string) => {
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      sendEvent({ type: "response.create" });
    },
    [sendEvent],
  );

  const cancelResponse = useCallback(() => {
    if (!activeResponseRef.current) return;
    activeResponseRef.current = false;
    sendEvent({ type: "response.cancel" });
  }, [sendEvent]);

  const sendContextualUpdate = useCallback(
    (text: string) => {
      // System note that does NOT trigger a response.
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text }],
        },
      });
    },
    [sendEvent],
  );

  const setVolume = useCallback(({ volume }: { volume: number }) => {
    if (audioElRef.current) {
      audioElRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    status,
    isSpeaking,
    startSession,
    endSession,
    sendUserMessage,
    cancelResponse,
    sendContextualUpdate,
    setVolume,
  };
}