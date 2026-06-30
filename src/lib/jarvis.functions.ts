import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("threads")
      .select("id,title,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ title: z.string().optional() }).parse(d ?? {}))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("threads")
      .insert({ user_id: context.userId, title: data.title ?? "New conversation" })
      .select("id,title,updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("threads").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getThreadMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ threadId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("messages")
      .select("id,role,content,created_at,attachments")
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const searchChats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ query: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ context, data }) => {
    const q = data.query.trim();
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const [titles, msgs] = await Promise.all([
      context.supabase
        .from("threads")
        .select("id,title,updated_at")
        .ilike("title", like)
        .order("updated_at", { ascending: false })
        .limit(30),
      context.supabase
        .from("messages")
        .select("id,thread_id,role,content,created_at")
        .ilike("content", like)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (titles.error) throw new Error(titles.error.message);
    if (msgs.error) throw new Error(msgs.error.message);
    return {
      threads: titles.data ?? [],
      messages: (msgs.data ?? []).map((m) => ({
        ...m,
        snippet: makeSnippet(m.content, q),
      })),
    };
  });

function makeSnippet(content: string, q: string) {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.slice(0, 140);
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + q.length + 90);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

export const addMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      threadId: z.string().uuid(),
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().min(1),
      attachments: z
        .array(
          z.object({
            path: z.string(),
            name: z.string(),
            mimeType: z.string(),
            size: z.number().int().optional(),
          }),
        )
        .optional(),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("messages")
      .insert({
        thread_id: data.threadId,
        user_id: context.userId,
        role: data.role,
        content: data.content,
        attachments: data.attachments ?? [],
      })
      .select("id,role,content,created_at,attachments")
      .single();
    if (error) throw new Error(error.message);
    await context.supabase
      .from("threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", data.threadId);
    return row;
  });

export const renameThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), title: z.string().min(1).max(120) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("threads")
      .update({ title: data.title })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getElevenLabsAgentToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;
    if (!apiKey) throw new Error("ElevenLabs is not connected");
    if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not configured");

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429 && /concurrent|capacity|rate/i.test(text)) {
        throw new Error("VOICE_RETRYABLE_CLOSING");
      }
      throw new Error(`Voice connection failed (${res.status}). Please try again.`);
    }
    const json = (await res.json()) as { token: string };
    return { token: json.token, agentId };
  });

export const getElevenLabsAgentSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;
    if (!apiKey) throw new Error("ElevenLabs is not connected");
    if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not configured");

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429 && /concurrent|capacity|rate/i.test(text)) {
        throw new Error("VOICE_RETRYABLE_CLOSING");
      }
      throw new Error(`Voice connection failed (${res.status}). Please try again.`);
    }
    const json = (await res.json()) as { signed_url: string };
    return { signedUrl: json.signed_url, agentId };
  });