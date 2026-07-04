// Minimal OpenAI Realtime WebRTC client. Kept dependency-free so the chat
// page can lazy-invoke it only when the user selects the "openai_realtime"
// voice provider.

import { supabase } from "@/integrations/supabase/client";
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
  onToolCall: (cb: (name: string, args: Record<string, unknown>, result: unknown) => void) => void;
  sendEvent: (event: Record<string, unknown>) => boolean;
  forceGenerateDocument: (hint?: string) => boolean;
};

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
  if (!localToolNames.includes("generate_document")) {
    phase("failed", "Missing generate_document tool");
    throw new Error("Voice session is missing generate_document locally. PDF/DOCX generation cannot start.");
  }
  if (documentToolRegistered === false || (registeredToolNames && !registeredToolNames.includes("generate_document"))) {
    console.warn(
      "[realtime] server session missing generate_document — will re-register client-side",
      registeredToolNames,
    );
  }
  const fallbackInstructions =
    "You can create downloadable PDFs, DOCX Word documents, Markdown files, spreadsheets, CSV, and TXT files with generate_document. For any create/export PDF, Word, Markdown, report, download, or attachment request, call generate_document immediately. Never say you cannot create files or PDFs; briefly confirm after the artifact is generated and do not read the full document aloud.";
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
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  let onToolCallCb: ((name: string, args: Record<string, unknown>, result: unknown) => void) | null = null;

  // Track streaming function-call argument deltas keyed by call_id.
  const pendingCalls = new Map<string, { name: string; args: string }>();
  const dispatchedCalls = new Set<string>();

  async function runTool(name: string, argsJson: string, callId: string) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson || "{}"); } catch { /* leave empty */ }
    let result: unknown;
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const jwt2 = s?.access_token;
      const resp = await fetch("/api/realtime/tool", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jwt2 ? { Authorization: `Bearer ${jwt2}` } : {}),
        },
        body: JSON.stringify({ name, arguments: args }),
      });
      result = await resp.json().catch(() => ({ error: `tool http ${resp.status}` }));
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "tool call failed" };
    }
    onToolCallCb?.(name, args, result);
    try {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch (err) {
      console.warn("realtime tool response send failed", err);
    }
  }

  let assistantBuf = "";
  let userInterimBuf = "";
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
  dc.addEventListener("open", () => {
    phase("live");
    // Defensively (re)register tools via session.update so document/email/web
    // tools are always available even if the ephemeral session config was
    // dropped upstream.
    if (Array.isArray(tools) && tools.length) {
      try {
        console.log("[realtime] registering client-side tools:", localToolNames.join(", "));
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              audio: {
                input: {
                  turn_detection: {
                    type: "semantic_vad",
                    eagerness: "low",
                    create_response: true,
                    interrupt_response: true,
                  },
                  transcription: { model: "whisper-1" },
                },
                output: { voice: voice ?? "alloy" },
              },
              tools,
              tool_choice: "auto",
              instructions: realtimeInstructions,
            },
          }),
        );
      } catch (err) {
        console.warn("[realtime] session.update tools failed", err);
      }
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
        case "session.created":
        case "session.updated": {
          const s = (msg as unknown as { session?: { tools?: Array<{ name?: string }> } }).session;
          const names = s?.tools?.map((t) => t?.name).filter(Boolean) ?? [];
          console.log("[realtime] session tools:", names.join(", ") || "(none)");
          if (msg.type === "session.updated" && !names.includes("generate_document")) {
            console.warn("[realtime] generate_document missing after session.update", names);
            onErrorCb?.(
              "Voice session is missing the document tool — PDF/DOCX generation unavailable until you restart the mic.",
            );
          }
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
        case "response.function_call_arguments.delta": {
          const id = msg.call_id ?? "";
          const existing = pendingCalls.get(id) ?? { name: msg.name ?? "", args: "" };
          existing.args += msg.delta ?? "";
          if (msg.name && !existing.name) existing.name = msg.name;
          pendingCalls.set(id, existing);
          break;
        }
        case "response.function_call_arguments.done": {
          const id = msg.call_id ?? "";
          const buf = pendingCalls.get(id);
          const name = msg.name ?? buf?.name ?? "";
          const argsJson = msg.arguments ?? buf?.args ?? "";
          pendingCalls.delete(id);
          if (name && id && !dispatchedCalls.has(id)) {
            dispatchedCalls.add(id);
            void runTool(name, argsJson, id);
          }
          break;
        }
        case "response.output_item.done": {
          const item = msg.item;
          if (item?.type === "function_call" && item.call_id && item.name && !dispatchedCalls.has(item.call_id)) {
            dispatchedCalls.add(item.call_id);
            void runTool(item.name, item.arguments ?? "", item.call_id);
            break;
          }
          emitParsedTranscript(msg);
          break;
        }
        case "error":
          onErrorCb?.(msg.error?.message ?? "OpenAI Realtime error");
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
    onToolCall: (cb) => { onToolCallCb = cb; },
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
    forceGenerateDocument: (hint) => {
      try {
        if (dc.readyState !== "open") return false;
        const instructions = [
          "The user requested a downloadable document. You MUST call the generate_document tool now.",
          "Do NOT reply with the document body as text. Do NOT ask for confirmation.",
          "Pick an appropriate format (default pdf if unspecified), a concise title and filename, and put the full document body in the markdown field, using the most recent relevant assistant answer and conversation context.",
          "After the tool result returns, speak exactly one short sentence such as: 'I generated the PDF — it's on screen.' Never read the document contents aloud.",
          hint ? `User request: ${hint}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        dc.send(
          JSON.stringify({
            type: "response.create",
            response: {
              tool_choice: { type: "function", name: "generate_document" },
              instructions,
            },
          }),
        );
        return true;
      } catch (err) {
        console.warn("[realtime] forceGenerateDocument failed", err);
        return false;
      }
    },
  };
}
