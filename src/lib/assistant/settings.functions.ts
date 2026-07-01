import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from "./types";

const SettingsSchema = z.object({
  interaction_mode: z.enum(["text", "push_to_talk", "continuous"]),
  voice_provider: z.enum(["elevenlabs", "openai_realtime", "none"]),
  model_provider: z.enum(["openai"]),
  cost_mode: z.enum(["economy", "balanced", "premium"]),
  max_voice_seconds: z.number().int().min(5).max(300),
  require_approval: z.boolean(),
  require_citations: z.boolean(),
});

export const getAssistantSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AssistantSettings> => {
    const { data, error } = await context.supabase
      .from("assistant_settings")
      .select(
        "interaction_mode,voice_provider,model_provider,cost_mode,max_voice_seconds,require_approval,require_citations",
      )
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return DEFAULT_ASSISTANT_SETTINGS;
    return data as AssistantSettings;
  });

export const updateAssistantSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SettingsSchema.parse(d))
  .handler(async ({ context, data }): Promise<AssistantSettings> => {
    const { data: row, error } = await context.supabase
      .from("assistant_settings")
      .upsert({ user_id: context.userId, ...data }, { onConflict: "user_id" })
      .select(
        "interaction_mode,voice_provider,model_provider,cost_mode,max_voice_seconds,require_approval,require_citations",
      )
      .single();
    if (error) throw new Error(error.message);
    return row as AssistantSettings;
  });