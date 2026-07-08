import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertUnderCap } from "@/lib/spend-cap.functions";

// OpenAI Realtime — mini is ~4× cheaper than the full model and plenty for chat.
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