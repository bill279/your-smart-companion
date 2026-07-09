import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUnderCap } from "@/lib/spend-cap.functions";
import { computeCost } from "@/lib/usage-pricing";
import { createRealtimeClientSecret, exchangeRealtimeOffer, realtimeModelName } from "@/lib/realtime-voice.server";
import { z } from "zod";

const RealtimeToolDefSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export const createRealtimeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      instructions: z.string().optional(),
      tools: z.array(RealtimeToolDefSchema).default([]),
    }).parse(d ?? {}),
  )
  .handler(async ({ context, data }) => {
    const realtimeModel = realtimeModelName();
    // Block if user is at/above their monthly spend cap.
    await assertUnderCap(context.supabase, context.userId);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not configured");
    const { clientSecret, expiresAt } = await createRealtimeClientSecret({
      apiKey: key,
      instructions: data.instructions,
      tools: data.tools,
    });
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

    const { answerSdp } = await exchangeRealtimeOffer({
      apiKey: key,
      sdp: data.sdp,
      instructions: data.instructions,
      tools: data.tools,
    });

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