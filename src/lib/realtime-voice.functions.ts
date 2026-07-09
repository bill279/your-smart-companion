import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUnderCap } from "@/lib/spend-cap.functions";
import { computeCost } from "@/lib/usage-pricing";
import { z } from "zod";

const RealtimeToolDefSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

const TRANSCRIPTION_PROMPT =
  "Business assistant voice commands. Common phrases: send it, email it to me, email that to, attach the PDF, convert to Word, convert to PDF, generate a report, add to calendar, book a meeting, cancel the meeting, reply to, follow up with, find, search for, look up. Common names include Bill, Randy, Jane, Mike, Sarah, John.";

function realtimeSessionConfig(input?: {
  instructions?: string;
  tools?: z.infer<typeof RealtimeToolDefSchema>[];
}) {
  // Keep these inside/imported for TanStack server-function splitting safety.
  const realtimeModel = "gpt-realtime-2.1";
  const realtimeVoice = "marin";
  const tools = input?.tools ?? [];
  return {
    type: "realtime",
    model: realtimeModel,
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
      output: { voice: realtimeVoice },
    },
    tools,
    tool_choice: tools.length > 0 ? "auto" : "none",
  };
}

function realtimeModelName() {
  return "gpt-realtime-2.1";
}

export const createRealtimeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const realtimeModel = realtimeModelName();
    // Block if user is at/above their monthly spend cap.
    await assertUnderCap(context.supabase, context.userId);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not configured");
    // `/v1/realtime/sessions` was retired — mint an ephemeral client secret
    // from the new `/v1/realtime/client_secrets` endpoint instead.
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: realtimeSessionConfig(),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Realtime session failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    // New response shape: `{ value, expires_at, session }`. Fall back to the
    // old `{ client_secret: { value } }` shape for safety.
    const data = (await res.json()) as {
      value?: string;
      expires_at?: number;
      client_secret?: { value: string; expires_at?: number };
    };
    const clientSecret = data.value ?? data.client_secret?.value;
    const expiresAt = data.expires_at ?? data.client_secret?.expires_at ?? null;
    if (!clientSecret) throw new Error("Realtime session missing client_secret");
    // Log a marker event so voice sessions show up in the spend dashboard.
    // Actual audio-token totals aren't returned here; we log the start
    // event with 0 cost — see usage-pricing.ts for the per-token rate.
    try {
      await context.supabase.from("usage_events").insert({
        user_id: context.userId,
        kind: "voice_session",
        model: realtimeModel,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        metadata: { event: "session_created" } as never,
      });
    } catch {
      /* ignore */
    }
    return {
      clientSecret,
      expiresAt,
      model: realtimeModel,
    };
  });

export const exchangeRealtimeSdp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      sdp: z.string().min(20),
      instructions: z.string().optional(),
      tools: z.array(RealtimeToolDefSchema).default([]),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const realtimeModel = realtimeModelName();
    await assertUnderCap(context.supabase, context.userId);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not configured");

    const fd = new FormData();
    fd.set("sdp", data.sdp);
    fd.set("session", JSON.stringify(realtimeSessionConfig({
      instructions: data.instructions,
      tools: data.tools,
    })));

    const res = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    const answerSdp = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Realtime SDP exchange failed (${res.status}): ${answerSdp.slice(0, 300)}`);
    }
    if (!answerSdp.trim()) throw new Error("Realtime SDP exchange returned an empty answer");

    try {
      await context.supabase.from("usage_events").insert({
        user_id: context.userId,
        kind: "voice_session",
        model: realtimeModel,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        metadata: { event: "session_created" } as never,
      });
    } catch {
      /* ignore */
    }

    return { answerSdp, model: realtimeModel };
  });

// Log per-turn realtime token usage from client-side `response.done` events.
// The realtime API returns audio + text token totals in `response.usage`;
// we price audio and text separately and insert one usage_event per turn.
export const logVoiceUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      inputAudioTokens: z.number().int().min(0).default(0),
      outputAudioTokens: z.number().int().min(0).default(0),
      inputTextTokens: z.number().int().min(0).default(0),
      outputTextTokens: z.number().int().min(0).default(0),
      responseId: z.string().optional(),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const realtimeModel = realtimeModelName();
    const audioCost = computeCost(realtimeModel, data.inputAudioTokens, data.outputAudioTokens);
    const textCost = computeCost("gpt-realtime-text", data.inputTextTokens, data.outputTextTokens);
    const total = audioCost + textCost;
    const totalIn = data.inputAudioTokens + data.inputTextTokens;
    const totalOut = data.outputAudioTokens + data.outputTextTokens;
    if (totalIn + totalOut === 0) return { ok: true, cost_usd: 0 };
    try {
      await context.supabase.from("usage_events").insert({
        user_id: context.userId,
        kind: "voice_turn",
        model: realtimeModel,
        input_tokens: totalIn,
        output_tokens: totalOut,
        cost_usd: total,
        metadata: {
          audio_in: data.inputAudioTokens,
          audio_out: data.outputAudioTokens,
          text_in: data.inputTextTokens,
          text_out: data.outputTextTokens,
          response_id: data.responseId ?? null,
        } as never,
      });
    } catch (err) {
      console.warn("logVoiceUsage insert failed", err);
    }
    return { ok: true, cost_usd: total };
  });