import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// OpenAI Realtime — mini is ~4× cheaper than the full model and plenty for chat.
const REALTIME_MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const REALTIME_VOICE = "alloy";

export const createRealtimeSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not configured");
    const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: REALTIME_MODEL, voice: REALTIME_VOICE }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Realtime session failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      client_secret?: { value: string; expires_at?: number };
    };
    const clientSecret = data.client_secret?.value;
    if (!clientSecret) throw new Error("Realtime session missing client_secret");
    return {
      clientSecret,
      expiresAt: data.client_secret?.expires_at ?? null,
      model: REALTIME_MODEL,
    };
  });