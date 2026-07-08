import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUnderCap } from "@/lib/spend-cap.functions";
import { computeCost } from "@/lib/usage-pricing";
import { z } from "zod";

// OpenAI Realtime — mini is ~4× cheaper than the full model and plenty for chat.
// Reverted from `gpt-realtime` to `gpt-realtime-mini` — the full model was
// ~4× the cost with no perceptible quality improvement (the realtime pipeline
// is bottlenecked by WebRTC/VAD/transcription, not the model).
const REALTIME_MODEL = "gpt-realtime-mini";
const REALTIME_VOICE = "alloy";

export const createRealtimeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
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
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          audio: { output: { voice: REALTIME_VOICE } },
        },
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
        model: REALTIME_MODEL,
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
      model: REALTIME_MODEL,
    };
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
    const audioCost = computeCost(REALTIME_MODEL, data.inputAudioTokens, data.outputAudioTokens);
    const textCost = computeCost("gpt-realtime-text", data.inputTextTokens, data.outputTextTokens);
    const total = audioCost + textCost;
    const totalIn = data.inputAudioTokens + data.inputTextTokens;
    const totalOut = data.outputAudioTokens + data.outputTextTokens;
    if (totalIn + totalOut === 0) return { ok: true, cost_usd: 0 };
    try {
      await context.supabase.from("usage_events").insert({
        user_id: context.userId,
        kind: "voice_turn",
        model: REALTIME_MODEL,
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