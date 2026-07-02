import { z } from "zod";

type SearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
};

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function extractOpenAiText(payload: unknown) {
  const direct = z.object({ output_text: z.string().optional() }).safeParse(payload);
  if (direct.success && direct.data.output_text) return direct.data.output_text;

  const parsed = z
    .object({
      output: z
        .array(
          z.object({
            content: z
              .array(
                z.object({
                  text: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .safeParse(payload);

  if (!parsed.success) return "";
  return (parsed.data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 8);
}

async function openAiSearch(query: string, limit: number) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "OPENAI_API_KEY missing" };

  const timeout = withTimeout(18000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-4.1-mini",
        tools: [{ type: "web_search_preview" }],
        input:
          `Search the live web for: ${query}\n\n` +
          `Return a concise answer and up to ${limit} source URLs. Include source URLs inline.`,
      }),
      signal: timeout.signal,
    });
    if (!response.ok) return { error: `OpenAI web search failed (${response.status})` };
    const payload = await response.json();
    const answer = extractOpenAiText(payload);
    const results: SearchResult[] = extractUrls(answer).map((url, index) => ({
      title: index === 0 ? `Live web result for ${query}` : `Source ${index + 1}`,
      url,
      snippet: answer.slice(0, 500),
    }));
    return { provider: "openai", query, answer, results };
  } catch {
    return { error: "OpenAI web search timed out" };
  } finally {
    timeout.done();
  }
}

async function firecrawlSearch(query: string, limit: number) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;

  const timeout = withTimeout(10000);
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: timeout.signal,
    });
    if (!response.ok) return { error: `Search failed (${response.status})` };
    const payload = (await response.json()) as {
      data?: { web?: Array<{ title?: string; url?: string; description?: string }> } | Array<{ title?: string; url?: string; description?: string }>;
    };
    const arr = Array.isArray(payload.data) ? payload.data : payload.data?.web ?? [];
    return {
      provider: "firecrawl",
      query,
      results: arr.slice(0, limit).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.description,
      })),
    };
  } catch {
    return { error: "Search timed out — try a more specific query." };
  } finally {
    timeout.done();
  }
}

export async function searchWeb(query: string, limit = 5) {
  const safeLimit = Math.min(Math.max(limit, 1), 10);
  return (await firecrawlSearch(query, safeLimit)) ?? openAiSearch(query, safeLimit);
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? htmlToText(title).slice(0, 160) : undefined;
}

async function basicScrape(url: string) {
  const timeout = withTimeout(12000);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "BPA-Bot/1.0 (+https://bpautomation.com)",
        Accept: "text/html,text/plain,application/xhtml+xml",
      },
      signal: timeout.signal,
    });
    if (!response.ok) return { error: `Scrape failed (${response.status})` };
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const markdown = contentType.includes("html") ? htmlToText(text) : text.trim();
    return {
      provider: "basic-fetch",
      title: contentType.includes("html") ? extractTitle(text) : undefined,
      url,
      markdown: markdown.length > 5000 ? `${markdown.slice(0, 5000)}\n\n…[truncated]` : markdown,
    };
  } catch {
    return { error: "Scrape timed out — skip this URL and try another." };
  } finally {
    timeout.done();
  }
}

async function firecrawlScrape(url: string) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;

  const timeout = withTimeout(12000);
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: timeout.signal,
    });
    if (!response.ok) return { error: `Scrape failed (${response.status})` };
    const payload = (await response.json()) as { data?: { markdown?: string; metadata?: { title?: string } } };
    const markdown = payload.data?.markdown ?? "";
    return {
      provider: "firecrawl",
      title: payload.data?.metadata?.title,
      url,
      markdown: markdown.length > 5000 ? `${markdown.slice(0, 5000)}\n\n…[truncated]` : markdown,
    };
  } catch {
    return { error: "Scrape timed out — skip this URL and try another." };
  } finally {
    timeout.done();
  }
}

export async function scrapeWeb(url: string) {
  return (await firecrawlScrape(url)) ?? basicScrape(url);
}
