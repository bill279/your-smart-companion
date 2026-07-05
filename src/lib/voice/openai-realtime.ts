// Minimal OpenAI Realtime WebRTC client. Kept dependency-free so the chat
// page can lazy-invoke it only when the user selects the "openai_realtime"
// voice provider.

import { supabase } from "@/integrations/supabase/client";
import {
  REALTIME_TRANSCRIPTION_MODEL,
  REALTIME_TRANSCRIPTION_PROMPT,
} from "./realtime-session-payload";
import { transcriptEventFromRealtime } from "./realtime-transcript-events";

export type RealtimePhase =
  | "preflight"
  | "requesting-mic"
  | "connecting"
  | "live"
  | "failed";

export type RealtimeSession = {
  stop: () => Promise<void>;
  onTranscript: (cb: (role: "user" | "assistant", text: string, done: boolean) => void) => void;
  onError: (cb: (message: string) => void) => void;
  onOpen: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  sendEvent: (event: Record<string, unknown>) => boolean;
};

function isBenignRealtimeError(message: string) {
  return /cancellation failed:\s*no active response found/i.test(message);
}

export async function preflightOpenAiRealtime(): Promise<{
  ok: boolean;
  message?: string;
  tools?: string[];
  documentToolRegistered?: boolean;
}> {
  try {
    const resp = await fetch("/api/realtime/session", { method: "GET" });
    const body = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      tools?: string[];
      documentToolRegistered?: boolean;
    };
    if (!resp.ok || !body?.ok) {
      return {
        ok: false,
        message:
          body?.message ??
          `Voice preflight failed (${resp.status}). Try again shortly or contact support.`,
      };
    }
    return {
      ok: true,
      tools: body.tools,
      documentToolRegistered: body.documentToolRegistered,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Preflight network error",
    };
  }
}

export async function startOpenAiRealtimeSession(options: {
  context?: string;
  onPhase?: (phase: RealtimePhase, detail?: string) => void;
} = {}): Promise<RealtimeSession> {
  const phase = (p: RealtimePhase, detail?: string) => {
    try { options.onPhase?.(p, detail); } catch { /* ignore */ }
  };
  phase("preflight");
  const pre = await preflightOpenAiRealtime();
  if (!pre.ok) {
    phase("failed", pre.message);
    throw new Error(pre.message ?? "OpenAI Realtime preflight failed.");
  }

  const { data: { session } } = await supabase.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) {
    phase("failed", "Not signed in.");
    throw new Error("Not signed in.");
  }

  const resp = await fetch("/api/realtime/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!resp.ok) {
    let msg = `Voice setup failed (${resp.status}).`;
    let retryable = false;
    try {
      const body = (await resp.json()) as {
        message?: string;
        status?: number;
        endpoint?: string;
        model?: string;
        requestId?: string | null;
        kind?: string;
        retryable?: boolean;
        attempts?: Array<{ model: string; status: number; requestId: string | null; kind: string }>;
        openaiBody?: string;
      };
      if (body?.message) msg = body.message;
      if (body?.status || body?.model || body?.requestId) {
        const extra = [
          body.status ? `OpenAI status ${body.status}` : "",
          body.model ? `model ${body.model}` : "",
          body.requestId ? `request ${body.requestId}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        if (extra) msg = `${msg} (${extra})`;
      }
      if (body?.retryable) retryable = true;
      console.error("[realtime] session creation failed", body);
    } catch { /* ignore */ }
    phase("failed", msg);
    const err = new Error(msg) as Error & { retryable?: boolean };
    err.retryable = retryable;
    throw err;
  }
  const { clientSecret, model, voice, tools, registeredToolNames, documentToolRegistered, instructions } = (await resp.json()) as {
    clientSecret: string;
    model: string;
    voice?: string;
    tools?: unknown[];
    registeredToolNames?: string[];
    documentToolRegistered?: boolean;
    instructions?: string;
  };
  const localToolNames = Array.isArray(tools)
    ? tools
        .map((tool) => (tool && typeof tool === "object" && "name" in tool ? String(tool.name) : ""))
        .filter(Boolean)
    : [];
  if (localToolNames.length || registeredToolNames?.length || documentToolRegistered) {
    console.log("[realtime] tools available:", localToolNames.concat(registeredToolNames ?? []).join(", ") || "(none)");
  }
  const fallbackInstructions =
    "You are BPA Bot. Answer directly and briefly. Use tools when the user needs live research, email, calendar, or file generation.";
  const realtimeInstructions = [instructions || fallbackInstructions, options.context?.trim()]
    .filter(Boolean)
    .join("\n\n");

  const pc = new RTCPeerConnection();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
  };

  phase("requesting-mic");
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const detail =
      err instanceof Error && /permission|denied|notallowed/i.test(err.message + err.name)
        ? "Microphone permission denied. Enable mic access for this site and tap the mic again."
        : err instanceof Error
          ? `Microphone unavailable: ${err.message}`
          : "Microphone unavailable.";
    phase("failed", detail);
    try { pc.close(); } catch { /* ignore */ }
    throw new Error(detail);
  }
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));

  const dc = pc.createDataChannel("oai-events");

  let onTranscriptCb: ((role: "user" | "assistant", text: string, done: boolean) => void) | null = null;
  let onErrorCb: ((message: string) => void) | null = null;
  let onOpenCb: (() => void) | null = null;
  let onCloseCb: (() => void) | null = null;

  let assistantBuf = "";
  let userInterimBuf = "";
  const inFlightToolCalls = new Set<string>();
  let lastFinalAssistant = "";
  let lastFinalUser = "";
  let lastFinalAssistantAt = 0;
  let lastFinalUserAt = 0;
  const shouldEmitFinal = (role: "user" | "assistant", text: string) => {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (!normalized) return false;
    const now = Date.now();
    if (role === "assistant") {
      if (normalized === lastFinalAssistant && now - lastFinalAssistantAt < 3000) return false;
      lastFinalAssistant = normalized;
      lastFinalAssistantAt = now;
      return true;
    }
    if (normalized === lastFinalUser && now - lastFinalUserAt < 3000) return false;
    lastFinalUser = normalized;
    lastFinalUserAt = now;
    return true;
  };
  const emitParsedTranscript = (msg: unknown) => {
    const parsed = transcriptEventFromRealtime(msg as Parameters<typeof transcriptEventFromRealtime>[0], {
      assistant: assistantBuf,
      user: userInterimBuf,
    });
    assistantBuf = parsed.next.assistant;
    userInterimBuf = parsed.next.user;
    if (!parsed.transcript) return;
    if (parsed.transcript.done && !shouldEmitFinal(parsed.transcript.role, parsed.transcript.text)) return;
    onTranscriptCb?.(parsed.transcript.role, parsed.transcript.text, parsed.transcript.done);
  };
  const parseToolArguments = (raw: string | undefined) => {
    if (!raw?.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { raw };
    }
  };
  const handleToolCall = async (call: { call_id?: string; name?: string; arguments?: string }) => {
    const callId = call.call_id;
    const name = call.name;
    if (!callId || !name || inFlightToolCalls.has(callId)) return;
    inFlightToolCalls.add(callId);
    let output: unknown;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token;
      if (!jwt) throw new Error("Not signed in.");
      const toolResp = await fetch("/api/realtime/tool", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          name,
          arguments: parseToolArguments(call.arguments),
        }),
      });
      output = await toolResp.json().catch(() => ({ error: `Tool failed (${toolResp.status})` }));
      if (!toolResp.ok) {
        output = {
          error: `Tool failed (${toolResp.status})`,
          detail: output,
        };
      }
      const maybeArtifact = output as {
        ok?: boolean;
        artifact?: { filename?: string };
      };
      if (name === "generate_document" && maybeArtifact.ok && maybeArtifact.artifact) {
        onTranscriptCb?.(
          "assistant",
          `Generated ${maybeArtifact.artifact.filename ?? "the document"}.\n\n\`\`\`bpa-artifact\n${JSON.stringify(maybeArtifact.artifact)}\n\`\`\``,
          true,
        );
      }
    } catch (err) {
      output = { error: err instanceof Error ? err.message : "Tool execution failed." };
    }
    try {
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
          },
        }),
      );
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch (err) {
      console.warn("[realtime] failed to return tool output", err);
    } finally {
      inFlightToolCalls.delete(callId);
    }
  };
  dc.addEventListener("open", () => {
    phase("live");
    try {
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "high",
                  create_response: true,
                  interrupt_response: true,
                },
                transcription: {
                  model: REALTIME_TRANSCRIPTION_MODEL,
                  language: "en",
                  prompt: REALTIME_TRANSCRIPTION_PROMPT,
                },
              },
              output: { voice: voice ?? "alloy" },
            },
            tools: Array.isArray(tools) ? tools : [],
            tool_choice: "auto",
            instructions: realtimeInstructions,
          },
        }),
      );
    } catch (err) {
      console.warn("[realtime] session.update transport config failed", err);
    }
    onOpenCb?.();
  });
  dc.addEventListener("message", (evt) => {
    try {
      const msg = JSON.parse(evt.data as string) as {
        type: string;
        delta?: string;
        text?: string;
        transcript?: string;
        error?: { message?: string };
        call_id?: string;
        name?: string;
        arguments?: string;
        item?: {
          type?: string;
          role?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
          content?: Array<{ type?: string; text?: string; transcript?: string }>;
        };
        response?: {
          output?: Array<{
            content?: Array<{ type?: string; text?: string; transcript?: string }>;
          }>;
        };
      };
      switch (msg.type) {
        case "response.function_call_arguments.done": {
          void handleToolCall({
            call_id: msg.call_id,
            name: msg.name,
            arguments: msg.arguments,
          });
          break;
        }
        case "session.created":
        case "session.updated": {
          const s = (msg as unknown as { session?: { tools?: Array<{ name?: string }> } }).session;
          const names = s?.tools?.map((t) => t?.name).filter(Boolean) ?? [];
          console.log("[realtime] session tools:", names.join(", ") || "(none)");
          break;
        }
        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
        case "response.text.delta":
        case "response.output_text.delta":
          emitParsedTranscript(msg);
          break;
        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
        case "response.text.done":
        case "response.output_text.done": {
          emitParsedTranscript(msg);
          break;
        }
        case "conversation.item.created":
        case "conversation.item.completed":
        case "response.done": {
          emitParsedTranscript(msg);
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
        case "input_audio_transcription.completed":
        case "conversation.item.input_audio_transcription.done": {
          emitParsedTranscript(msg);
          break;
        }
        case "conversation.item.input_audio_transcription.delta":
        case "input_audio_transcription.delta":
          emitParsedTranscript(msg);
          break;
        case "response.output_item.done": {
          if (msg.item?.type === "function_call") {
            void handleToolCall({
              call_id: msg.item.call_id ?? msg.call_id,
              name: msg.item.name ?? msg.name,
              arguments: msg.item.arguments ?? msg.arguments,
            });
            break;
          }
          emitParsedTranscript(msg);
          break;
        }
        case "error":
          {
            const message = msg.error?.message ?? "OpenAI Realtime error";
            if (isBenignRealtimeError(message)) {
              console.debug("[realtime] ignored benign error:", message);
              break;
            }
            onErrorCb?.(message);
          }
          break;
      }
    } catch { /* ignore non-JSON frames */ }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  phase("connecting");
  const sdpUrl = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`;
  const sdpResp = await fetch(sdpUrl, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpResp.ok) {
    const detail = await sdpResp.text().catch(() => "");
    mic.getTracks().forEach((t) => t.stop());
    pc.close();
    console.error("[realtime] SDP exchange failed", sdpResp.status, sdpUrl, detail);
    phase("failed", `SDP ${sdpResp.status}`);
    throw new Error(
      `OpenAI Realtime SDP exchange failed (${sdpResp.status}) at ${sdpUrl}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") phase("live");
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) onCloseCb?.();
  });

  return {
    stop: async () => {
      try { dc.close(); } catch { /* ignore */ }
      try { mic.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { pc.close(); } catch { /* ignore */ }
      try { audioEl.srcObject = null; } catch { /* ignore */ }
    },
    onTranscript: (cb) => { onTranscriptCb = cb; },
    onError: (cb) => { onErrorCb = cb; },
    onOpen: (cb) => { onOpenCb = cb; },
    onClose: (cb) => { onCloseCb = cb; },
    sendEvent: (event) => {
      try {
        if (dc.readyState !== "open") return false;
        dc.send(JSON.stringify(event));
        return true;
      } catch (err) {
        console.warn("[realtime] sendEvent failed", err);
        return false;
      }
    },
  };
}
