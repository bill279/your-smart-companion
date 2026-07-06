import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Returns the Microsoft consent URL for the current signed-in user to complete OAuth. */
export const getMicrosoftAuthorizeUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { origin: string }) => {
    if (!/^https?:\/\//.test(data.origin)) throw new Error("Invalid origin");
    return data;
  })
  .handler(async ({ context, data }) => {
    const { signOauthState, buildAuthorizeUrl } = await import("@/lib/ms-graph.server");
    const state = signOauthState(context.userId);
    const redirectUri = `${data.origin}/api/public/ms-oauth/callback`;
    return { url: buildAuthorizeUrl(state, redirectUri) };
  });

/** Returns the currently-connected Microsoft account email (or null). */
export const getMicrosoftConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("ms_oauth_tokens")
      .select("ms_email,updated_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    return { connected: !!data, email: data?.ms_email ?? null, updatedAt: data?.updated_at ?? null };
  });

export const disconnectMicrosoftAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("ms_oauth_tokens").delete().eq("user_id", context.userId);
    return { ok: true };
  });