import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getVoiceQuota = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return { available: false as const };
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) return { available: false as const, error: `HTTP ${res.status}` };
      const data = (await res.json()) as {
        character_count?: number;
        character_limit?: number;
        next_character_count_reset_unix?: number;
        tier?: string;
      };
      const used = data.character_count ?? 0;
      const limit = data.character_limit ?? 0;
      const remaining = Math.max(0, limit - used);
      const percentUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;
      return {
        available: true as const,
        used,
        limit,
        remaining,
        percentUsed,
        resetAt: data.next_character_count_reset_unix
          ? data.next_character_count_reset_unix * 1000
          : null,
        tier: data.tier ?? null,
      };
    } catch (err) {
      return {
        available: false as const,
        error: err instanceof Error ? err.message : "Failed to load quota",
      };
    }
  });