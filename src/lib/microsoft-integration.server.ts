import crypto from "node:crypto";
import { z } from "zod";
import { marked } from "marked";
import type { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
  "Calendars.ReadWrite",
] as const;

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const MeResponse = z.object({
  id: z.string().optional(),
  displayName: z.string().nullable().optional(),
  mail: z.string().email().nullable().optional(),
  userPrincipalName: z.string().email().nullable().optional(),
});

type IntegrationRow = {
  user_id: string;
  provider: string;
  provider_account_email: string | null;
  scopes: string[] | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
};

type UserSupabaseClient = ReturnType<typeof createClient<Database>>;
const MICROSOFT_FACT_KEY = "microsoft_integration";
export const MICROSOFT_OAUTH_COOKIE = "bpa_ms_oauth";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function tenant() {
  return process.env.MICROSOFT_TENANT_ID || "common";
}

function authorizeUrl() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`;
}

function tokenUrl() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
}

function sign(payload: string) {
  return crypto
    .createHmac("sha256", requiredEnv("OAUTH_STATE_SECRET"))
    .update(payload)
    .digest("base64url");
}

function encryptionKey() {
  return crypto.createHash("sha256").update(requiredEnv("OAUTH_STATE_SECRET")).digest();
}

function encryptJson(value: unknown) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptJson<T>(value: string): T {
  const [version, ivText, tagText, encryptedText] = value.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Invalid encrypted Microsoft integration payload");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export function createMicrosoftOAuthCookie(
  request: Request,
  accessToken: string,
  userId: string,
) {
  const value = encryptJson({
    accessToken,
    userId,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${MICROSOFT_OAUTH_COOKIE}=${encodeURIComponent(value)}; Path=/api/integrations/microsoft; Max-Age=600; HttpOnly; SameSite=Lax${secure}`;
}

export function clearMicrosoftOAuthCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${MICROSOFT_OAUTH_COOKIE}=; Path=/api/integrations/microsoft; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function readMicrosoftOAuthCookie(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MICROSOFT_OAUTH_COOKIE}=`));
  if (!cookie) throw new Error("Microsoft connection session expired. Please try Connect Microsoft again.");
  const value = decodeURIComponent(cookie.slice(MICROSOFT_OAUTH_COOKIE.length + 1));
  const payload = decryptJson<{ accessToken?: string; userId?: string; exp?: number }>(value);
  if (!payload.accessToken || !payload.userId || !payload.exp) {
    throw new Error("Microsoft connection session is invalid. Please try again.");
  }
  if (Date.now() > payload.exp) {
    throw new Error("Microsoft connection session expired. Please try again.");
  }
  return { accessToken: payload.accessToken, userId: payload.userId };
}

export function createMicrosoftOAuthState(userId: string) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      provider: "microsoft",
      exp: Date.now() + 10 * 60 * 1000,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyMicrosoftOAuthState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new Error("Invalid OAuth state");
  const expected = sign(payload);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid OAuth state signature");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    userId?: string;
    provider?: string;
    exp?: number;
  };
  if (decoded.provider !== "microsoft" || !decoded.userId || !decoded.exp) {
    throw new Error("Invalid OAuth state payload");
  }
  if (Date.now() > decoded.exp) throw new Error("OAuth state expired");
  return { userId: decoded.userId };
}

export function microsoftRedirectUri(request: Request) {
  return new URL("/api/integrations/microsoft/callback", request.url).toString();
}

export function buildMicrosoftAuthUrl(request: Request, userId: string) {
  const params = new URLSearchParams({
    client_id: requiredEnv("MICROSOFT_CLIENT_ID"),
    response_type: "code",
    redirect_uri: microsoftRedirectUri(request),
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state: createMicrosoftOAuthState(userId),
    prompt: "select_account",
  });
  return `${authorizeUrl()}?${params}`;
}

export async function exchangeMicrosoftCode(request: Request, code: string) {
  const response = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("MICROSOFT_CLIENT_ID"),
      client_secret: requiredEnv("MICROSOFT_CLIENT_SECRET"),
      code,
      redirect_uri: microsoftRedirectUri(request),
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Microsoft token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  return TokenResponse.parse(JSON.parse(text));
}

async function getMicrosoftMe(accessToken: string) {
  const response = await fetch(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return MeResponse.parse(await response.json());
}

export async function getMicrosoftIntegration(
  supabase: UserSupabaseClient,
  userId: string,
) {
  const { data, error } = await supabase
    .from("user_facts")
    .select("value")
    .eq("user_id", userId)
    .eq("key", MICROSOFT_FACT_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.value) return null;
  return decryptJson<IntegrationRow>(data.value);
}

async function refreshMicrosoftAccessToken(
  supabase: UserSupabaseClient,
  row: IntegrationRow,
) {
  if (!row.refresh_token) throw new Error("Microsoft refresh token missing. Reconnect Outlook.");
  const response = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("MICROSOFT_CLIENT_ID"),
      client_secret: requiredEnv("MICROSOFT_CLIENT_SECRET"),
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Microsoft token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  const token = TokenResponse.parse(JSON.parse(text));
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  const updated: IntegrationRow = {
    ...row,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? row.refresh_token,
    expires_at: expiresAt,
    scopes: token.scope ? token.scope.split(" ") : row.scopes ?? [...MICROSOFT_SCOPES],
  };
  await upsertMicrosoftFact(supabase, row.user_id, updated);
  return updated;
}

export async function getFreshMicrosoftAccessToken(
  supabase: UserSupabaseClient,
  userId: string,
) {
  const row = await getMicrosoftIntegration(supabase, userId);
  if (!row) throw new Error("Microsoft Outlook is not connected.");
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt && expiresAt > Date.now() + 60_000) return row.access_token;
  const refreshed = await refreshMicrosoftAccessToken(supabase, row);
  return refreshed.access_token;
}

async function upsertMicrosoftFact(
  supabase: UserSupabaseClient,
  userId: string,
  integration: IntegrationRow,
) {
  const { error } = await supabase.from("user_facts").upsert(
    {
      user_id: userId,
      key: MICROSOFT_FACT_KEY,
      value: encryptJson(integration),
      source: "microsoft_oauth",
    },
    { onConflict: "user_id,key" },
  );
  if (error) throw new Error(error.message);
}

export async function saveMicrosoftIntegration(
  supabase: UserSupabaseClient,
  userId: string,
  token: z.infer<typeof TokenResponse>,
) {
  const me = await getMicrosoftMe(token.access_token);
  const existing = await getMicrosoftIntegration(supabase, userId);
  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  await upsertMicrosoftFact(supabase, userId, {
    user_id: userId,
    provider: "microsoft",
    provider_account_email: me?.mail ?? me?.userPrincipalName ?? existing?.provider_account_email ?? null,
    scopes: token.scope ? token.scope.split(" ") : [...MICROSOFT_SCOPES],
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? existing?.refresh_token ?? null,
    expires_at: expiresAt,
    metadata: {
      graph_id: me?.id,
      displayName: me?.displayName,
    },
  });
}

export async function disconnectMicrosoftIntegration(
  supabase: UserSupabaseClient,
  userId: string,
) {
  const { error } = await supabase
    .from("user_facts")
    .delete()
    .eq("user_id", userId)
    .eq("key", MICROSOFT_FACT_KEY);
  if (error) throw new Error(error.message);
}

export async function microsoftIntegrationStatus(
  supabase: UserSupabaseClient,
  userId: string,
) {
  const row = await getMicrosoftIntegration(supabase, userId);
  return {
    connected: Boolean(row),
    email: row?.provider_account_email ?? null,
    scopes: row?.scopes ?? [],
    expires_at: row?.expires_at ?? null,
  };
}

function renderEmailHtml(markdown: string) {
  const inner = marked.parse(markdown, { gfm: true, breaks: true, async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;margin:0;padding:24px;background:#fff;}
.container{max-width:640px;margin:0 auto;}
h1,h2,h3{color:#0b2545;margin:1.2em 0 .4em;}
p{margin:.6em 0;} a{color:#0b6e3f;}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;}
th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top;}
th{background:#0b2545;color:#fff;font-weight:600;} tr:nth-child(even) td{background:#f8fafc;}
</style></head><body><div class="container">${inner}</div></body></html>`;
}

export async function sendOutlookMail(
  supabase: UserSupabaseClient,
  userId: string,
  message: { to: string; subject: string; body: string; cc?: string },
) {
  const accessToken = await getFreshMicrosoftAccessToken(supabase, userId);
  const response = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: "HTML", content: renderEmailHtml(message.body) },
        toRecipients: [{ emailAddress: { address: message.to } }],
        ...(message.cc ? { ccRecipients: [{ emailAddress: { address: message.cc } }] } : {}),
      },
      saveToSentItems: true,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Outlook send failed (${response.status}): ${text.slice(0, 300)}`);
  return { ok: true };
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mapGraphMessage(message: {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string | null; address?: string | null } } | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string | null } | null;
  isRead?: boolean | null;
  webLink?: string | null;
  toRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string | null; address?: string | null } }>;
}) {
  const bodyContent = message.body?.content ?? "";
  return {
    id: message.id,
    subject: message.subject ?? "(no subject)",
    from: {
      name: message.from?.emailAddress?.name ?? null,
      address: message.from?.emailAddress?.address ?? null,
    },
    receivedDateTime: message.receivedDateTime ?? null,
    sentDateTime: message.sentDateTime ?? null,
    bodyPreview: message.bodyPreview ?? null,
    body:
      message.body?.contentType?.toLowerCase() === "html"
        ? stripHtml(bodyContent)
        : bodyContent || null,
    isRead: Boolean(message.isRead),
    webLink: message.webLink ?? null,
    to: (message.toRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? null,
      address: r.emailAddress?.address ?? null,
    })),
    cc: (message.ccRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? null,
      address: r.emailAddress?.address ?? null,
    })),
  };
}

export async function listMicrosoftMailMessages(
  supabase: UserSupabaseClient,
  userId: string,
  options: {
    query?: string;
    from?: string;
    unreadOnly?: boolean;
    top?: number;
  },
) {
  const accessToken = await getFreshMicrosoftAccessToken(supabase, userId);
  const top = Math.min(Math.max(options.top ?? 10, 1), 50);
  const select = "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink";
  const params = new URLSearchParams({
    $top: String(top),
    $select: select,
  });

  let url = `${GRAPH_BASE}/me/messages?${params}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };

  if (options.query?.trim()) {
    const search = options.query.trim().replace(/"/g, '\\"');
    params.set("$search", `"${search}"`);
    // Graph does not support $orderby with $search on messages. Search results
    // are relevance-ranked; we sort the returned slice by received date below.
    url = `${GRAPH_BASE}/me/messages?${params}`;
    headers.ConsistencyLevel = "eventual";
  } else {
    const filters: string[] = [];
    if (options.unreadOnly) filters.push("isRead eq false");
    if (filters.length) params.set("$filter", filters.join(" and "));
    params.set("$orderby", "receivedDateTime desc");
    url = `${GRAPH_BASE}/me/messages?${params}`;
  }

  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Outlook mail search failed (${response.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as {
    value?: Array<Parameters<typeof mapGraphMessage>[0]>;
  };
  let messages = (data.value ?? []).map(mapGraphMessage);
  if (options.query?.trim() && options.unreadOnly) {
    messages = messages.filter((m) => !m.isRead);
  }
  if (options.from?.trim()) {
    const needle = options.from.trim().toLowerCase();
    messages = messages.filter((m) => {
      const name = m.from.name?.toLowerCase() ?? "";
      const address = m.from.address?.toLowerCase() ?? "";
      return name.includes(needle) || address.includes(needle);
    });
  }
  messages.sort((a, b) => {
    const at = a.receivedDateTime ? new Date(a.receivedDateTime).getTime() : 0;
    const bt = b.receivedDateTime ? new Date(b.receivedDateTime).getTime() : 0;
    return bt - at;
  });
  return messages.slice(0, top);
}

export async function getMicrosoftMailMessage(
  supabase: UserSupabaseClient,
  userId: string,
  messageId: string,
) {
  const accessToken = await getFreshMicrosoftAccessToken(supabase, userId);
  const params = new URLSearchParams({
    $select: "id,subject,from,receivedDateTime,sentDateTime,bodyPreview,body,isRead,webLink,toRecipients,ccRecipients",
  });
  const response = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Outlook mail read failed (${response.status}): ${text.slice(0, 300)}`);
  return mapGraphMessage(JSON.parse(text) as Parameters<typeof mapGraphMessage>[0]);
}

function looksActionableEmail(message: {
  subject: string;
  bodyPreview: string | null;
  isRead: boolean;
}) {
  const text = `${message.subject} ${message.bodyPreview ?? ""}`.toLowerCase();
  if (!message.isRead) return true;
  return /\b(question|can you|could you|please|need|needed|review|approve|approval|confirm|follow up|following up|deadline|due|urgent|asap|proposal|quote|estimate|invoice|meeting|schedule|available|availability)\b/.test(text);
}

export async function getMicrosoftMorningBriefing(
  supabase: UserSupabaseClient,
  userId: string,
  options: { mailTop?: number; calendarDays?: number } = {},
) {
  const mailTop = Math.min(Math.max(options.mailTop ?? 15, 5), 30);
  const calendarDays = Math.min(Math.max(options.calendarDays ?? 2, 1), 7);
  const [unread, recent, events] = await Promise.all([
    listMicrosoftMailMessages(supabase, userId, { unreadOnly: true, top: mailTop }),
    listMicrosoftMailMessages(supabase, userId, { top: mailTop }),
    listMicrosoftCalendarEvents(supabase, userId, { days: calendarDays, maxResults: 15 }),
  ]);
  const byId = new Map<string, (typeof recent)[number]>();
  for (const message of [...unread, ...recent]) byId.set(message.id, message);
  const actionable = [...byId.values()]
    .filter(looksActionableEmail)
    .sort((a, b) => {
      if (!a.isRead && b.isRead) return -1;
      if (a.isRead && !b.isRead) return 1;
      const at = a.receivedDateTime ? new Date(a.receivedDateTime).getTime() : 0;
      const bt = b.receivedDateTime ? new Date(b.receivedDateTime).getTime() : 0;
      return bt - at;
    })
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    unreadCountInSample: unread.length,
    unread,
    actionable,
    upcomingEvents: events,
  };
}

export async function prepareMicrosoftReplyContext(
  supabase: UserSupabaseClient,
  userId: string,
  options: { query?: string; from?: string; id?: string },
) {
  let targetId = options.id;
  if (!targetId) {
    const candidates = await listMicrosoftMailMessages(supabase, userId, {
      query: options.query,
      from: options.from,
      top: 5,
    });
    targetId = candidates[0]?.id;
  }
  if (!targetId) throw new Error("No matching Outlook email found.");
  const message = await getMicrosoftMailMessage(supabase, userId, targetId);
  const to = message.from.address;
  if (!to) throw new Error("The selected email does not have a replyable sender address.");
  return {
    original: message,
    draftTo: to,
    draftSubject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
    instructions:
      "Draft a concise professional reply. Do not send it. Show the full draft preview and wait for explicit approval.",
  };
}

export async function listMicrosoftCalendarEvents(
  supabase: UserSupabaseClient,
  userId: string,
  options: { days?: number; maxResults?: number },
) {
  const accessToken = await getFreshMicrosoftAccessToken(supabase, userId);
  const now = new Date();
  const end = new Date(now.getTime() + (options.days ?? 7) * 86400000);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: "start/dateTime",
    $top: String(options.maxResults ?? 10),
  });
  const response = await fetch(`${GRAPH_BASE}/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Outlook calendar read failed (${response.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as {
    value?: Array<{
      id: string;
      subject?: string;
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      location?: { displayName?: string };
      webLink?: string;
      attendees?: Array<{ emailAddress?: { address?: string } }>;
    }>;
  };
  return (data.value ?? []).map((event) => ({
    id: event.id,
    title: event.subject ?? "(no title)",
    start: event.start?.dateTime,
    end: event.end?.dateTime,
    timezone: event.start?.timeZone,
    location: event.location?.displayName,
    link: event.webLink,
    attendees: (event.attendees ?? []).map((attendee) => attendee.emailAddress?.address).filter(Boolean),
  }));
}

export async function createMicrosoftCalendarEvent(
  supabase: UserSupabaseClient,
  userId: string,
  event: {
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    timezone?: string;
  },
) {
  const accessToken = await getFreshMicrosoftAccessToken(supabase, userId);
  const response = await fetch(`${GRAPH_BASE}/me/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: event.title,
      body: event.description ? { contentType: "HTML", content: event.description } : undefined,
      start: { dateTime: event.start, timeZone: event.timezone ?? "UTC" },
      end: { dateTime: event.end, timeZone: event.timezone ?? "UTC" },
      ...(event.location ? { location: { displayName: event.location } } : {}),
      ...(event.attendees?.length
        ? {
            attendees: event.attendees.map((email) => ({
              emailAddress: { address: email },
              type: "required",
            })),
          }
        : {}),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Outlook calendar create failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as { id?: string; webLink?: string };
}
