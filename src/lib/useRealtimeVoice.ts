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
  isFinal?: boolean;
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
  const assistantAudibleRef = useRef(false);
  const localSpeechActiveRef = useRef(false);
  const userTranscriptAccumRef = useRef<Map<string, string>>(new Map());
  const responseCreatePendingRef = useRef(false);
  const responseCreateInFlightRef = useRef(false);
  const responseInstructionsPendingRef = useRef<string | undefined>(undefined);
  const micMonitorRef = useRef<{
    ctx: AudioContext;
    analyser: AnalyserNode;
    source: MediaStreamAudioSourceNode;
    raf: number;
  } | null>(null);
  const localBargeInAtRef = useRef(0);
  const instantMuteAtRef = useRef(0);
  const instantMuteReleaseTimerRef = useRef<number | null>(null);

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
    if (micMonitorRef.current) {
      try { cancelAnimationFrame(micMonitorRef.current.raf); } catch (err) { console.warn(err); }
      try { micMonitorRef.current.source.disconnect(); } catch (err) { console.warn(err); }
      try { micMonitorRef.current.ctx.close(); } catch (err) { console.warn(err); }
      micMonitorRef.current = null;
    }
    if (audioElRef.current) {
      try { audioElRef.current.srcObject = null; } catch (err) { console.warn(err); }
    }
    assistantAccumRef.current.clear();
    userTranscriptAccumRef.current.clear();
    activeResponseRef.current = false;
    assistantAudibleRef.current = false;
    localSpeechActiveRef.current = false;
    responseCreatePendingRef.current = false;
    responseCreateInFlightRef.current = false;
    responseInstructionsPendingRef.current = undefined;
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

  // Cut the assistant off immediately at every layer. Called both from the
  // server VAD event (input_audio_buffer.speech_started) and from a local
  // WebAudio RMS monitor so the user doesn't have to wait for the server
  // round-trip to feel the interruption.
  const bargeInNow = useCallback(() => {
    const now = Date.now();
    // Debounce so server + local paths don't stomp each other repeatedly.
    if (now - localBargeInAtRef.current < 150) return;
    localBargeInAtRef.current = now;
    const el = audioElRef.current;
    if (el) {
      try { el.muted = true; } catch (err) { console.warn(err); }
      try { el.pause(); } catch (err) { console.warn(err); }
      try { el.volume = 0; } catch (err) { console.warn(err); }
    }
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" });
    setIsSpeaking(false);
  }, [sendEvent]);

  // Instant local mute: fires on the FIRST loud frame while the assistant
  // is audible, WITHOUT sending anything to the server. Gives the user a
  // true two-way-sync feel — audio drops the instant they open their
  // mouth. If it turns out to be a noise blip and no confirmed speech
  // follows within ~250ms, we un-mute automatically so the assistant
  // isn't clipped by a cough or keyboard click.
  const instantMuteLocalPlayback = useCallback(() => {
    if (!assistantAudibleRef.current && !activeResponseRef.current) return;
    const now = Date.now();
    if (now - instantMuteAtRef.current < 80) return;
    instantMuteAtRef.current = now;
    const el = audioElRef.current;
    if (el) {
      try { el.muted = true; } catch (err) { console.warn(err); }
      try { el.volume = 0; } catch (err) { console.warn(err); }
    }
    if (instantMuteReleaseTimerRef.current !== null) {
      window.clearTimeout(instantMuteReleaseTimerRef.current);
    }
    instantMuteReleaseTimerRef.current = window.setTimeout(() => {
      instantMuteReleaseTimerRef.current = null;
      // If a real barge-in happened, bargeInNow already handled state.
      // Otherwise the noise was a false alarm — restore playback.
      if (localSpeechActiveRef.current) return;
      const el2 = audioElRef.current;
      if (!el2) return;
      try { el2.muted = false; } catch (err) { console.warn(err); }
      try { el2.volume = 1; } catch (err) { console.warn(err); }
      if (el2.paused && (assistantAudibleRef.current || activeResponseRef.current)) {
        el2.play().catch(() => {});
      }
    }, 260);
  }, []);

  const markLocalSpeechStarted = useCallback(() => {
    if (localSpeechActiveRef.current) return;
    localSpeechActiveRef.current = true;
    // Do not wait for the remote VAD/transcription round-trip. As soon as the
    // user's mic has speech-level energy while the assistant is audible, cut
    // playback locally and tell the realtime session the user is speaking.
    if (assistantAudibleRef.current || activeResponseRef.current) {
      bargeInNow();
    }
  }, [bargeInNow]);

  const releaseBargeIn = useCallback(() => {
    if (instantMuteReleaseTimerRef.current !== null) {
      window.clearTimeout(instantMuteReleaseTimerRef.current);
      instantMuteReleaseTimerRef.current = null;
    }
    const el = audioElRef.current;
    if (!el) return;
    try { el.muted = false; } catch (err) { console.warn(err); }
    try { el.volume = 1; } catch (err) { console.warn(err); }
    if (el.paused) { el.play().catch(() => {}); }
  }, []);

  const requestResponseCreate = useCallback((instructions?: string) => {
    if (instructions?.trim()) {
      responseInstructionsPendingRef.current = instructions.trim();
    }
    if (activeResponseRef.current || responseCreateInFlightRef.current) {
      responseCreatePendingRef.current = true;
      return;
    }
    responseCreatePendingRef.current = false;
    responseCreateInFlightRef.current = true;
    const pendingInstructions = responseInstructionsPendingRef.current;
    responseInstructionsPendingRef.current = undefined;
    const event = pendingInstructions
      ? { type: "response.create", response: { instructions: pendingInstructions, tool_choice: "none" } }
      : { type: "response.create" };
    if (!sendEvent(event)) {
      responseCreateInFlightRef.current = false;
    }
  }, [sendEvent]);

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
          responseCreateInFlightRef.current = false;
          if (responseCreatePendingRef.current) window.setTimeout(requestResponseCreate, 0);
          return;
        }
        // Realtime only allows one response at a time. If a create raced the
        // prior turn finishing, queue it for the next response.done instead of
        // surfacing the scary provider error to the user.
        if (/active response in progress|already has an active response/i.test(err)) {
          activeResponseRef.current = true;
          responseCreateInFlightRef.current = false;
          responseCreatePendingRef.current = true;
          return;
        }
        opts.onError?.(err);
        return;
      }

      if (type === "response.created") {
        activeResponseRef.current = true;
        responseCreateInFlightRef.current = false;
        return;
      }

      if (
        type === "conversation.item.input_audio_transcription.delta" ||
        type === "conversation.item.input_audio_transcription.updated"
      ) {
        const itemId = String(msg.item_id ?? "live");
        const delta = String(msg.delta ?? "");
        const transcript = String(msg.transcript ?? "");
        const next = (transcript || `${userTranscriptAccumRef.current.get(itemId) ?? ""}${delta}`).trim();
        if (next) userTranscriptAccumRef.current.set(itemId, next);
        const text = next;
        if (text) {
          opts.onMessage?.({ source: "user", message: text, event_id: itemId, isFinal: false });
        }
        return;
      }

      // User speech transcription complete.
      if (
        type === "conversation.item.input_audio_transcription.completed" ||
        type === "conversation.item.input_audio_transcription.done"
      ) {
        const itemId = String(msg.item_id ?? "");
        const text = String(msg.transcript ?? "").trim();
        if (itemId) userTranscriptAccumRef.current.delete(itemId);
        if (text) {
          opts.onMessage?.({ source: "user", message: text, event_id: itemId, isFinal: true });
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
        assistantAudibleRef.current = true;
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
        assistantAudibleRef.current = true;
        setIsSpeaking(true);
        return;
      }

      // BARGE-IN: the user started talking while the assistant was speaking.
      // Cut the assistant off IMMEDIATELY at every layer:
      //   1. Mute the local <audio> element so the user stops hearing it now
      //      (WebRTC audio already buffered client-side would otherwise keep
      //      playing for up to a second after the server stops sending).
      //   2. Ask the server to cancel the in-flight response.
      //   3. Clear any audio still queued in the server's output buffer.
      if (type === "input_audio_buffer.speech_started") {
        localSpeechActiveRef.current = true;
        bargeInNow();
        return;
      }
      // User's speech ended — re-enable the audio element so the next
      // assistant response is audible again.
      if (type === "input_audio_buffer.speech_stopped") {
        localSpeechActiveRef.current = false;
        releaseBargeIn();
        return;
      }

      if (
        type === "output_audio_buffer.stopped" ||
        type === "response.output_audio.done" ||
        type === "response.done"
      ) {
        assistantAudibleRef.current = false;
        setIsSpeaking(false);
        if (type === "response.done") {
          activeResponseRef.current = false;
          responseCreateInFlightRef.current = false;
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
          if (responseCreatePendingRef.current) {
            responseCreatePendingRef.current = false;
            window.setTimeout(requestResponseCreate, 0);
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
          if (shouldCreateResponse) requestResponseCreate();
          return;
        }
        sendEvent({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        });
        requestResponseCreate();
        return;
      }
    },
    [bargeInNow, releaseBargeIn, requestResponseCreate, sendEvent],
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

        const stream = opts.microphoneStream ?? await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        localStreamRef.current = stream;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        // Local RMS monitor: fires bargeInNow() the instant the mic picks up
        // voice-level energy, so we don't wait ~200–500ms for the server VAD
        // event to round-trip back over the data channel.
        try {
          const AudioCtx =
            (window.AudioContext ||
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext)!;
          const ctx = new AudioCtx();
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0;
          source.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          let quietCount = 0;
          let loudCount = 0;
          let instantHitCount = 0;
          const tick = () => {
            if (!micMonitorRef.current) return;
            analyser.getByteTimeDomainData(buf);
            // RMS around 128 midpoint, 0..1
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);
            // Two-tier gate for true two-way-sync feel:
            //  * INSTANT tier — very low latency local mute. As soon as
            //    the mic sees mild energy over 2 frames (~32ms) while
            //    the assistant is speaking, drop local playback. This
            //    is what makes it FEEL like ChatGPT voice: the audio
            //    stops the instant you open your mouth. If it turns
            //    out to be a cough / keyboard click / breath, the
            //    auto-release in instantMuteLocalPlayback unmutes.
            //  * CONFIRM tier — the real "user is speaking" decision.
            //    Only after sustained voice-level energy do we send
            //    response.cancel to the server, so background noise
            //    doesn't kill legitimate responses.
            const INSTANT_RMS  = 0.035;     // low: catch first syllable
            const INSTANT_FRAMES = 2;       // ~32ms
            const SPEECH_RMS   = 0.07;      // higher gate for real speech
            const SPEECH_FRAMES = 4;        // ~64ms sustained
            if (rms > INSTANT_RMS) {
              instantHitCount++;
              if (
                instantHitCount >= INSTANT_FRAMES &&
                (assistantAudibleRef.current || activeResponseRef.current) &&
                !localSpeechActiveRef.current
              ) {
                instantMuteLocalPlayback();
              }
            } else {
              instantHitCount = 0;
            }
            if (rms > SPEECH_RMS) {
              loudCount++;
              quietCount = 0;
              if (
                loudCount >= SPEECH_FRAMES &&
                (assistantAudibleRef.current || activeResponseRef.current)
              ) {
                markLocalSpeechStarted();
              }
            } else {
              loudCount = 0;
              quietCount++;
              if (quietCount > 12) localSpeechActiveRef.current = false;
            }
            micMonitorRef.current.raf = requestAnimationFrame(tick);
          };
          micMonitorRef.current = { ctx, analyser, source, raf: 0 };
          micMonitorRef.current.raf = requestAnimationFrame(tick);
        } catch (err) {
          console.warn("mic monitor init failed", err);
        }

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
                  transcription: { model: "gpt-4o-transcribe" },
              // Semantic VAD uses a model to decide when the user is
              // actually speaking vs. making noise (breathing, throat
              // clearing, keyboard, background hum). "high" eagerness
              // reacts quickly to real speech while still rejecting
              // non-speech energy — much better than raw energy-threshold
              // server_vad, which trips on any sound above the level.
              turn_detection: {
                type: "semantic_vad",
                // "medium" is much less trigger-happy on breath / hums /
                // background chatter than "high" while still reacting in
                // well under a second. Local instant-mute already gives
                // the perceived instant stop, so we don't need "high"
                // eagerness at the cost of false transcriptions.
                eagerness: "medium",
                create_response: false,
                interrupt_response: true,
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
    (text: string, opts?: { createResponse?: boolean; instructions?: string }) => {
      // If a prior response is still generating, cancel it so the new
      // user message doesn't collide with "active response in progress".
      if (activeResponseRef.current || responseCreateInFlightRef.current) {
        sendEvent({ type: "response.cancel" });
      }
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      if (opts?.createResponse !== false) requestResponseCreate(opts?.instructions);
    },
    [requestResponseCreate, sendEvent],
  );

  const cancelResponse = useCallback(() => {
    responseCreatePendingRef.current = false;
    responseInstructionsPendingRef.current = undefined;
    if (!activeResponseRef.current && !responseCreateInFlightRef.current) return;
    sendEvent({ type: "response.cancel" });
  }, [sendEvent]);

  const createResponse = useCallback(
    (instructions?: string) => {
      requestResponseCreate(instructions);
    },
    [requestResponseCreate],
  );

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
    createResponse,
    cancelResponse,
    sendContextualUpdate,
    setVolume,
  };
}