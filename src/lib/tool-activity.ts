// Shared helpers for streaming/rendering "live search" style tool activity
// (Claude-style chips showing what the AI is searching / opening in real time).

export type ToolEvent =
  | {
      t: "call";
      id: string;
      name: "web_search" | "web_scrape" | "product_search";
      input: { query?: string; url?: string; limit?: number };
    }
  | {
      t: "result";
      id: string;
      name: "web_search" | "web_scrape" | "product_search";
      output: unknown;
    };

// Record shape rendered in the UI (call + result merged by id).
export type ToolActivity = {
  id: string;
  name: "web_search" | "web_scrape" | "product_search";
  query?: string;
  url?: string;
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
  scraped?: { title?: string; url?: string };
  products?: Array<{
    title?: string;
    url?: string;
    image?: string;
    price?: string;
    merchant?: string;
    snippet?: string;
  }>;
  error?: string;
};

// ASCII Record Separator — chosen so it can't collide with normal model output.
export const TOOL_FRAME_DELIM = "\u001e";

/**
 * Marker embedded at the top of a persisted assistant message so tool
 * activity survives page reloads (mirrors the pattern used for artifacts).
 */
export const TOOL_ACTIVITY_MARKER_RE = /<!--tool-activity:([A-Za-z0-9+/=]+)-->\s*/;

export function encodeToolActivityMarker(activities: ToolActivity[]): string {
  if (!activities.length) return "";
  const json = JSON.stringify(activities);
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(json)))
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(json, "utf8").toString("base64");
  return `<!--tool-activity:${b64}-->\n\n`;
}

export function extractToolActivity(content: string): {
  activities: ToolActivity[];
  content: string;
} {
  const m = content.match(TOOL_ACTIVITY_MARKER_RE);
  if (!m) return { activities: [], content };
  try {
    const b64 = m[1];
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).Buffer.from(b64, "base64").toString("utf8");
    const activities = JSON.parse(json) as ToolActivity[];
    return { activities, content: content.replace(TOOL_ACTIVITY_MARKER_RE, "") };
  } catch {
    return { activities: [], content: content.replace(TOOL_ACTIVITY_MARKER_RE, "") };
  }
}

/** Merge a tool-call/tool-result event stream into UI activity records. */
export function foldToolEvent(
  prev: ToolActivity[],
  ev: ToolEvent,
): ToolActivity[] {
  const idx = prev.findIndex((a) => a.id === ev.id);
  const base: ToolActivity =
    idx >= 0
      ? { ...prev[idx] }
      : {
          id: ev.id,
          name: ev.name,
        };
  if (ev.t === "call") {
    base.query = ev.input?.query ?? base.query;
    base.url = ev.input?.url ?? base.url;
  } else {
    const out = ev.output as {
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
      products?: Array<{
        title?: string;
        url?: string;
        image?: string;
        price?: string;
        merchant?: string;
        snippet?: string;
      }>;
      title?: string;
      error?: string;
    } | null;
    if (out?.error) base.error = out.error;
    if (ev.name === "web_search") {
      base.results = out?.results ?? [];
    } else if (ev.name === "web_scrape") {
      base.scraped = { title: out?.title, url: base.url };
    } else if (ev.name === "product_search") {
      base.products = out?.products ?? [];
    }
  }
  const next = prev.slice();
  if (idx >= 0) next[idx] = base;
  else next.push(base);
  return next;
}

export function faviconFor(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return null;
  }
}

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
