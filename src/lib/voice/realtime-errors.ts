// Pure helpers for classifying OpenAI Realtime session-creation errors and
// choosing a safe fallback model. Extracted so they can be unit-tested
// without touching the network.

export const REALTIME_PRIMARY_MODEL = "gpt-realtime";
// Only used when the primary model returns a server-side failure OR the
// account cannot access `gpt-realtime`. Kept as a *preview* model per
// OpenAI's public naming.
export const REALTIME_FALLBACK_MODELS = ["gpt-4o-realtime-preview"] as const;

export type RealtimeFailureKind =
  | "server_error" // OpenAI 5xx — transient, retry / try fallback model
  | "model_unavailable" // 404 / model_not_found — try fallback model
  | "unauthorized" // 401 — bad key
  | "rate_limited" // 429 — quota / rate limit
  | "bad_request" // 400 — our payload is wrong
  | "unknown";

export function classifyRealtimeFailure(
  status: number,
  bodyText: string,
): RealtimeFailureKind {
  if (status >= 500) return "server_error";
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_unavailable";
  if (status === 400) {
    if (/model[_\s-]?not[_\s-]?found|does not exist|no access/i.test(bodyText)) {
      return "model_unavailable";
    }
    return "bad_request";
  }
  return "unknown";
}

export function shouldTryFallbackModel(kind: RealtimeFailureKind): boolean {
  return kind === "server_error" || kind === "model_unavailable";
}

export function pickNextRealtimeModel(alreadyTried: readonly string[]): string | null {
  const chain = [REALTIME_PRIMARY_MODEL, ...REALTIME_FALLBACK_MODELS];
  for (const m of chain) {
    if (!alreadyTried.includes(m)) return m;
  }
  return null;
}

export function humanRealtimeError(
  kind: RealtimeFailureKind,
  status: number,
  requestId: string | null,
  model: string,
): string {
  const idSuffix = requestId ? ` (request ${requestId})` : "";
  switch (kind) {
    case "server_error":
      return `OpenAI returned a temporary server error (${status}) for ${model}${idSuffix}. Tap the mic to retry.`;
    case "unauthorized":
      return "OpenAI rejected the API key. Verify OPENAI_API_KEY in project secrets.";
    case "rate_limited":
      return `OpenAI rate limit or quota exceeded${idSuffix}. Wait a moment and retry.`;
    case "model_unavailable":
      return `OpenAI Realtime model ${model} is not available for this key${idSuffix}. Ask an administrator to enable Realtime access.`;
    case "bad_request":
      return `OpenAI rejected the session request (400)${idSuffix}. This is a server-side config bug, not a user issue.`;
    default:
      return `OpenAI Realtime session creation failed (${status})${idSuffix}.`;
  }
}

// Extract an OpenAI request id from response headers. OpenAI uses
// `x-request-id` on the REST APIs; some proxies mirror it as
// `openai-request-id`. Never include the API key.
export function extractRequestId(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("openai-request-id") ??
    headers.get("x-openai-request-id") ??
    null
  );
}