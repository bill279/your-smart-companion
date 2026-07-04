// Shared OpenAI Realtime tool schemas. Kept in a plain module so both the
// server session endpoint and unit tests can inspect them without pulling in
// server-only code paths.

export const REALTIME_TOOL_NAMES = [
  "web_search",
  "web_scrape",
  "get_outlook_briefing",
  "prepare_outlook_reply",
  "search_outlook_mail",
  "read_outlook_email",
  "send_email",
  "generate_document",
] as const;

export type RealtimeToolName = (typeof REALTIME_TOOL_NAMES)[number];

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web for current information (news, prices, companies, people, products). Returns titles, urls, and snippets. Final answers must cite returned urls as clickable Markdown links.",
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
    name: "search_outlook_mail",
    description:
      "Search or list the user's connected Outlook mailbox. Use for unread summaries, latest emails, sender searches, inbox triage, and finding emails to reply to. Returns ids, sender, subject, date, read status, preview, and Outlook link.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional keyword search across Outlook messages" },
        from: { type: "string", description: "Optional sender name or email filter" },
        unreadOnly: { type: "boolean", description: "Only return unread messages" },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_outlook_briefing",
    description:
      "Create a concise workday briefing from the user's connected Outlook mailbox and calendar: unread/actionable emails, emails that may need replies, upcoming events, and suggested priorities.",
    parameters: {
      type: "object",
      properties: {
        mailTop: { type: "integer", minimum: 5, maximum: 30 },
        calendarDays: { type: "integer", minimum: 1, maximum: 7 },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "prepare_outlook_reply",
    description:
      "Find/read an Outlook email and return context for drafting a reply. Use when the user asks to reply to the latest email from someone or draft a response from mailbox context. Does not send.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Specific Outlook message id if already known" },
        query: { type: "string", description: "Optional keyword search if no id is known" },
        from: { type: "string", description: "Optional sender name or email to find the latest matching email from" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "read_outlook_email",
    description:
      "Read the full body of one Outlook email by id. Use only after search_outlook_mail returns the id and the preview is insufficient.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Outlook message id returned by search_outlook_mail" },
      },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "send_email",
    description:
      "Send an email from the user's connected Outlook/Gmail account. Only call after the immediately previous assistant turn presented a complete draft/readback and the user's latest reply explicitly approved it. Include approved: true only for clear approvals such as send, yes send, confirm, approved, or looks good send it. Never call from the initial email request.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Email body in Markdown" },
        cc: { type: "string", description: "Optional Cc email address" },
        approved: {
          type: "boolean",
          description:
            "Must be true only after explicit approval from the user's latest reply. Omit or false when drafting or asking for approval.",
        },
      },
      required: ["to", "subject", "body", "approved"],
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
