// Background self-improvement loop.
//
// After a conversation crosses a threshold of turns, we quietly ask GPT-5.5
// to read the transcript and extract 0–3 DURABLE lessons — the kind of
// standing preferences or corrections the assistant should apply forever
// (e.g. "the user's sign-off is 'Bilal, BP Automation'", or "when scheduling
// with Randy, default to mornings before 11am Central").
//
// Lessons are stored in `lessons_learned` and automatically injected into
// the system prompt on every future call (see src/routes/api/chat.ts).
//
// This runs fire-and-forget from the chat route's onFinish hook. Any error
// is swallowed so it never affects the user's response.

import { createClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

const MIN_MESSAGES_TO_REVIEW = 6;
const REVIEW_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const LessonsSchema = z.object({
  lessons: z
    .array(
      z.object({
        lesson: z.string().min(4).max(240),
        context: z.string().max(200).optional(),
      }),
    )
    .max(3),
});

const REVIEW_PROMPT = `You are a strict quality reviewer looking at a finished conversation between a user and an AI assistant. Your job is to extract DURABLE lessons — corrections, preferences, or workflow rules the assistant should apply in EVERY future conversation with this user.

Rules:
- Return AT MOST 3 lessons. Zero is a valid answer — do not invent.
- Only save something if it is a standing preference or a real correction. NOT one-off facts, NOT summaries of what happened, NOT restatements of what the assistant already did well.
- Prefer lessons that would prevent the assistant from repeating a mistake, or that capture how the user likes things done.
- Each lesson must be phrased as an imperative rule ("Always...", "Never...", "When X, do Y", "The user prefers...").
- Skip anything obvious, generic, or already covered by common sense.
- Ignore chit-chat, greetings, and single-turn Q&A.

Return strict JSON: { "lessons": [ { "lesson": "...", "context": "..." } ] }`;

export async function reviewThreadForLessons(threadId: string, userId: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!supabaseUrl || !serviceKey || !lovableKey) return;

  const supabase = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Cooldown check
  const { data: thread } = await supabase
    .from("threads")
    .select("last_reviewed_at")
    .eq("id", threadId)
    .single();
  if (thread?.last_reviewed_at) {
    const ageMs = Date.now() - new Date(thread.last_reviewed_at).getTime();
    if (ageMs < REVIEW_COOLDOWN_MS) return;
  }

  // Pull the last ~40 messages
  const { data: messages } = await supabase
    .from("messages")
    .select("role,content,created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(40);
  const rows = (messages ?? []).slice().reverse();
  if (rows.length < MIN_MESSAGES_TO_REVIEW) return;

  // Load existing lessons so the reviewer can avoid re-saving duplicates.
  const { data: existing } = await supabase
    .from("lessons_learned")
    .select("lesson")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  const existingLessons = (existing ?? []).map((r) => r.lesson.toLowerCase());

  const transcript = rows
    .map((r) => {
      // Strip any embedded tool-activity marker from prior assistant messages
      const clean = (r.content ?? "").replace(/<!--tool-activity:[^>]*-->/g, "").trim();
      return `${r.role.toUpperCase()}: ${clean.slice(0, 2000)}`;
    })
    .join("\n\n");

  try {
    const gateway = createLovableAiGatewayProvider(lovableKey);
    const { text } = await generateText({
      model: gateway("openai/gpt-5.5"),
      messages: [
        { role: "system", content: REVIEW_PROMPT },
        {
          role: "user",
          content: `Existing lessons already saved (do NOT repeat or paraphrase these):\n${
            existingLessons.length > 0 ? existingLessons.map((l) => `- ${l}`).join("\n") : "(none)"
          }\n\nConversation transcript:\n\n${transcript}\n\nReturn strict JSON only.`,
        },
      ],
    });

    // Extract first JSON object from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      await supabase.from("threads").update({ last_reviewed_at: new Date().toISOString() }).eq("id", threadId);
      return;
    }
    const parsed = LessonsSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) {
      await supabase.from("threads").update({ last_reviewed_at: new Date().toISOString() }).eq("id", threadId);
      return;
    }

    const fresh = parsed.data.lessons.filter((l) => {
      const key = l.lesson.trim().toLowerCase();
      if (existingLessons.some((e) => e.includes(key.slice(0, 40)) || key.includes(e.slice(0, 40)))) return false;
      return true;
    });

    if (fresh.length > 0) {
      await supabase.from("lessons_learned").insert(
        fresh.map((l) => ({
          user_id: userId,
          lesson: l.lesson.trim(),
          context: l.context?.trim() || null,
          source: "auto_review",
        })),
      );
      console.log(`[self-improvement] Saved ${fresh.length} lesson(s) from thread ${threadId}`);
    }

    await supabase.from("threads").update({ last_reviewed_at: new Date().toISOString() }).eq("id", threadId);
  } catch (err) {
    // Swallow — this must never break the chat response
    console.error("[self-improvement] Review failed:", err);
  }
}