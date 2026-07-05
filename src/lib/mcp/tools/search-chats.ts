import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "search_chats",
  title: "Search chat history",
  description: "Full-text search across the signed-in user's thread titles and message contents.",
  inputSchema: {
    query: z.string().min(1).max(200).describe("Search text."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const [titles, msgs] = await Promise.all([
      supabase
        .from("threads")
        .select("id,title,updated_at")
        .ilike("title", like)
        .order("updated_at", { ascending: false })
        .limit(30),
      supabase
        .from("messages")
        .select("id,thread_id,role,content,created_at")
        .ilike("content", like)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (titles.error) return { content: [{ type: "text", text: titles.error.message }], isError: true };
    if (msgs.error) return { content: [{ type: "text", text: msgs.error.message }], isError: true };
    const result = { threads: titles.data ?? [], messages: msgs.data ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
});