import { createHmac, timingSafeEqual, randomBytes } from "crypto";

// Scopes we ask for on delegated Microsoft Graph OAuth
export const MS_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Send",
  "Mail.ReadWrite",
  "Calendars.ReadWrite",
  "OnlineMeetings.ReadWrite",
].join(" ");

function tenantAuthority() {
  const tenant = process.env.MS_TENANT_ID;
  if (!tenant) throw new Error("MS_TENANT_ID is not configured");
  return `https://login.microsoftonline.com/${tenant}`;
}

function stateSecret() {
  // Reuse the existing shared secret rather than adding another env var.
  const s = process.env.JARVIS_TOOL_SECRET;
  if (!s) throw new Error("JARVIS_TOOL_SECRET is not configured");
  return s;
}

export function signOauthState(userId: string): string {
  const payload = { u: userId, n: randomBytes(8).toString("hex"), t: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOauthState(state: string): { userId: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.u || typeof payload.u !== "string") return null;
    if (typeof payload.t !== "number" || Date.now() - payload.t > 15 * 60 * 1000) return null;
    return { userId: payload.u };
  } catch {
    return null;
  }
}

export function getMicrosoftRedirectUri(request: Request): string {
  // Use the request origin so this works on preview, prod, and custom domains.
  const url = new URL(request.url);
  return `${url.origin}/api/public/ms-oauth/callback`;
}

export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) throw new Error("MS_CLIENT_ID is not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MS_SCOPES,
    state,
    // Force the Microsoft consent screen so newly-added permissions like
    // OnlineMeetings.ReadWrite are actually granted instead of silently reusing
    // the previous cached sign-in.
    prompt: "consent",
  });
  return `${tenantAuthority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
};

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    client_secret: process.env.MS_CLIENT_SECRET!,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: MS_SCOPES,
  });
  const r = await fetch(`${tenantAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    throw new Error(`Microsoft token exchange failed (${r.status}): ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

async function refreshToken(refreshTokenValue: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    client_secret: process.env.MS_CLIENT_SECRET!,
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    scope: MS_SCOPES,
  });
  const r = await fetch(`${tenantAuthority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    throw new Error(`Microsoft token refresh failed (${r.status}): ${await r.text()}`);
  }
  return (await r.json()) as TokenResponse;
}

export async function fetchMsUserProfile(accessToken: string): Promise<{ id?: string; mail?: string; userPrincipalName?: string }> {
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return {};
  return (await r.json()) as { id?: string; mail?: string; userPrincipalName?: string };
}

/**
 * Get a valid access token for the given app user, refreshing if needed.
 * Returns null if the user has not connected Microsoft yet.
 */
export async function getMicrosoftAccessToken(userId: string): Promise<{ accessToken: string; email: string | null } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("ms_oauth_tokens")
    .select("access_token,refresh_token,expires_at,ms_email")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;

  const expiresAt = new Date(data.expires_at).getTime();
  // Refresh 60s early to avoid races
  if (expiresAt - 60_000 > Date.now()) {
    return { accessToken: data.access_token, email: data.ms_email };
  }

  const refreshed = await refreshToken(data.refresh_token);
  const newExpires = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await supabaseAdmin
    .from("ms_oauth_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? data.refresh_token,
      expires_at: newExpires,
      scope: refreshed.scope ?? null,
    })
    .eq("user_id", userId);
  return { accessToken: refreshed.access_token, email: data.ms_email };
}

export async function saveMicrosoftTokens(
  userId: string,
  token: TokenResponse,
): Promise<{ ms_email: string | null }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const profile = await fetchMsUserProfile(token.access_token);
  const email = profile.mail ?? profile.userPrincipalName ?? null;
  const expires = new Date(Date.now() + token.expires_in * 1000).toISOString();
  if (!token.refresh_token) {
    throw new Error("Microsoft did not return a refresh_token — ensure offline_access scope was granted.");
  }
  await supabaseAdmin.from("ms_oauth_tokens").upsert({
    user_id: userId,
    ms_email: email,
    ms_user_id: profile.id ?? null,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope ?? null,
    expires_at: expires,
  });
  return { ms_email: email };
}

export async function disconnectMicrosoft(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("ms_oauth_tokens").delete().eq("user_id", userId);
}