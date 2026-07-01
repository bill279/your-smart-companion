// Minimal OpenAI Realtime WebRTC client. Kept dependency-free so the chat
// page can lazy-invoke it only when the user selects the "openai_realtime"
// voice provider.

import { supabase } from "@/integrations/supabase/client";

export type RealtimeSession = {
  stop: () => Promise<void>;
  onTranscript: (cb: (role: "user" | "assistant", text: string, done: boolean) => void) => void;
  onError: (cb: (message: string) => void) => void;
  onOpen: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  onToolCall: (cb: (name: string, args: Record<string, unknown>, result: unknown) => void) => void;
};

export async function startOpenAiRealtimeSession(): Promise<RealtimeSession> {
  const { data: { session } } = await supabase.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) throw new Error("Not signed in.");

  const resp = await fetch("/api/realtime/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!resp.ok) {
    let msg = `Voice setup failed (${resp.status}).`;
    try {
      const body = (await resp.json()) as { message?: string };
      if (body?.message) msg = body.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const { clientSecret, model } = (await resp.json()) as {
    clientSecret: string;
    model: string;
  };

  const pc = new RTCPeerConnection();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
  };

  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));

  const dc = pc.createDataChannel("oai-events");

  let onTranscriptCb: ((role: "user" | "assistant", text: string, done: boolean) => void) | null = null;
  let onErrorCb: ((message: string) => void) | null = null;
  let onOpenCb: (() => void) | null = null;
  let onCloseCb: (() => void) | null = null;
  let onToolCallCb: ((name: string, args: Record<string, unknown>, result: unknown) => void) | null = null;

  // Track streaming function-call argument deltas keyed by call_id.
  const pendingCalls = new Map<string, { name: string; args: string }>();

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
  dc.addEventListener("open", () => onOpenCb?.());
  dc.addEventListener("message", (evt) => {
    try {
      const msg = JSON.parse(evt.data as string) as {
        type: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
        call_id?: string;
        name?: string;
        arguments?: string;
        item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      };
      switch (msg.type) {
        case "response.audio_transcript.delta":
          assistantBuf += msg.delta ?? "";
          onTranscriptCb?.("assistant", assistantBuf, false);
          break;
        case "response.audio_transcript.done":
          onTranscriptCb?.("assistant", assistantBuf, true);
          assistantBuf = "";
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript) onTranscriptCb?.("user", msg.transcript, true);
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
          if (name && id) void runTool(name, argsJson, id);
          break;
        }
        case "response.output_item.done": {
          const item = msg.item;
          if (item?.type === "function_call" && item.call_id && item.name) {
            void runTool(item.name, item.arguments ?? "", item.call_id);
          }
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

  const sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpResp.ok) {
    mic.getTracks().forEach((t) => t.stop());
    pc.close();
    throw new Error(`OpenAI Realtime SDP exchange failed (${sdpResp.status}).`);
  }
  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  pc.addEventListener("connectionstatechange", () => {
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
  };
}