export const TRANSCRIPTION_PROMPT =
  "Business assistant voice commands. Common phrases: send it, email it to me, email that to, attach the PDF, convert to Word, convert to PDF, generate a report, add to calendar, book a meeting, cancel the meeting, reply to, follow up with, find, search for, look up. Common names include Bill, Randy, Jane, Mike, Sarah, John.";

type RealtimeToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function realtimeModelName() {
  return "gpt-realtime-2.1";
}

export function realtimeSessionConfig(input?: {
  instructions?: string;
  tools?: RealtimeToolDef[];
}) {
  const tools = input?.tools ?? [];
  return {
    type: "realtime",
    model: realtimeModelName(),
    output_modalities: ["audio"],
    instructions: input?.instructions ?? "",
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
          language: "en",
          prompt: TRANSCRIPTION_PROMPT,
        },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: false,
          interrupt_response: true,
        },
      },
      output: { voice: "marin" },
    },
    tools,
    tool_choice: tools.length > 0 ? "auto" : "none",
  } satisfies Record<string, unknown>;
}

type RealtimeClientSecret = {
  clientSecret: string;
  expiresAt: number | null;
};

type RealtimeExchangeResult = {
  answerSdp: string;
  providerStatus?: number;
};

function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function isRetryableRealtimeStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function compactProviderError(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function createRealtimeClientSecret(input: {
  apiKey: string;
  instructions?: string;
  tools?: RealtimeToolDef[];
  timeoutMs?: number;
}): Promise<RealtimeClientSecret> {
  const timeout = timeoutSignal(input.timeoutMs ?? 8_000);
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: realtimeSessionConfig({
          instructions: input.instructions,
          tools: input.tools,
        }),
      }),
      signal: timeout.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Realtime session failed (${res.status}): ${compactProviderError(errText)}`);
    }
    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value: string; expires_at?: number };
    };
    const clientSecret = data.value ?? data.client_secret?.value;
    const expiresAt = data.expires_at ?? data.client_secret?.expires_at ?? null;
    if (!clientSecret) throw new Error("Realtime session missing client_secret");
    return { clientSecret, expiresAt };
  } finally {
    timeout.cancel();
  }
}

export async function exchangeRealtimeOffer(input: {
  apiKey: string;
  sdp: string;
  instructions?: string;
  tools?: RealtimeToolDef[];
}): Promise<RealtimeExchangeResult> {
  const session = realtimeSessionConfig({
    instructions: input.instructions,
    tools: input.tools,
  });
  let lastError: Error | null = null;

  // Primary path from the current Realtime WebRTC docs: backend sends the
  // browser SDP + session config as multipart/form-data with the standard key.
  const unifiedTimeout = timeoutSignal(12_000);
  try {
    const fd = new FormData();
    fd.set("sdp", input.sdp);
    fd.set("session", JSON.stringify(session));
    const res = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: fd,
      signal: unifiedTimeout.signal,
    });
    const answerSdp = await res.text().catch(() => "");
    if (res.ok) {
      if (!answerSdp.trim()) throw new Error("Realtime SDP exchange returned an empty answer");
      return { answerSdp, providerStatus: res.status };
    }
    const detail = compactProviderError(answerSdp);
    lastError = new Error(`Realtime SDP exchange failed (${res.status}): ${detail || "provider rejected the voice handshake"}`);
    if (!isRetryableRealtimeStatus(res.status)) throw lastError;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    lastError = error.name === "AbortError"
      ? new Error("Realtime provider timed out while starting voice")
      : error;
  } finally {
    unifiedTimeout.cancel();
  }

  // Fallback path: mint an ephemeral secret and perform a raw SDP exchange.
  // This avoids leaving voice down when the unified multipart endpoint returns
  // a transient gateway timeout for a specific request.
  try {
    const { clientSecret } = await createRealtimeClientSecret({
      apiKey: input.apiKey,
      instructions: input.instructions,
      tools: input.tools,
      timeoutMs: 5_000,
    });
    const fallbackTimeout = timeoutSignal(10_000);
    try {
      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: input.sdp,
        signal: fallbackTimeout.signal,
      });
      const answerSdp = await res.text().catch(() => "");
      if (!res.ok) {
        const detail = compactProviderError(answerSdp);
        throw new Error(`Realtime SDP exchange failed (${res.status}): ${detail || "provider rejected the voice handshake"}`);
      }
      if (!answerSdp.trim()) throw new Error("Realtime SDP exchange returned an empty answer");
      return { answerSdp, providerStatus: res.status };
    } finally {
      fallbackTimeout.cancel();
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "AbortError") throw new Error("Realtime provider timed out while starting voice");
    throw error.message ? error : (lastError ?? error);
  }
}