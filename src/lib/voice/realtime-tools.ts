// Shared OpenAI Realtime tool schemas. Kept in a plain module so both the
// server session endpoint and unit tests can inspect them without pulling in
// server-only code paths.

export const REALTIME_TOOL_NAMES = [
  "web_search",
  "web_scrape",
  "send_email",
  "generate_document",
] as const;

export type RealtimeToolName = (typeof REALTIME_TOOL_NAMES)[number];

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web for current information (news, prices, companies, people, products). Returns titles, urls, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "integer", minimum: 1, maximum: 6 },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "web_scrape",
    description: "Fetch the readable markdown content of a specific URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute URL to fetch" } },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "send_email",
    description:
      "Send an email from the user's connected Outlook/Gmail account. Only call after the user has verbally approved the draft.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Email body in Markdown" },
        cc: { type: "string", description: "Optional Cc email address" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    type: "function",
    name: "generate_document",
    description:
      "Generate a downloadable PDF, DOCX, Markdown, XLSX, CSV, or TXT file and return an artifact with a signed download URL. The chat UI renders a download card automatically. Never read the generated content aloud.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["pdf", "docx", "md", "xlsx", "csv", "txt"] },
        filename: { type: "string", description: "Base filename without extension" },
        title: { type: "string" },
        summary: { type: "string", description: "Optional short executive summary (1-3 sentences)" },
        sources: {
          type: "array",
          description: "Optional citations",
          items: {
            type: "object",
            properties: { title: { type: "string" }, url: { type: "string" } },
            required: ["title", "url"],
          },
        },
        markdown: { type: "string", description: "Full document body in Markdown" },
      },
      required: ["format", "filename", "title", "markdown"],
    },
  },
] as const;

export function realtimeToolNames(): string[] {
  return REALTIME_TOOLS.map((t) => t.name);
}

export function realtimeHasTool(name: RealtimeToolName): boolean {
  return REALTIME_TOOLS.some((t) => t.name === name);
}