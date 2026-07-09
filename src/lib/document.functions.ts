import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Words that show up as whole "filenames" when Whisper mishears voice
// filler ("gosh?" → "Crash", "under…" + something → "Underwordog").
// Anything matching these patterns is treated as garbage and replaced
// with the document's real title.
function looksLikeVoiceGarbageFilename(raw: string): boolean {
  const t = (raw ?? "").trim().replace(/\.(pdf|docx|xlsx|csv|txt)$/i, "");
  if (!t) return true;
  if (/[?!]$/.test(t)) return true;
  if (/^(?:crash|gosh|huh|what|okay|ok|yeah|yes|nope|nah|sure|hmm|uh|um|send|it|that|this|thing|stuff|doc|document|file|new|untitled)$/i.test(t)) return true;
  // Single lowercase or CamelCase token with no vowel pairs and not in a
  // sensible word shape — treat as gibberish.
  if (/^[A-Za-z]+$/.test(t) && t.length >= 6 && !/\s/.test(t)) {
    const vowels = (t.match(/[aeiouAEIOU]/g) ?? []).length;
    const ratio = vowels / t.length;
    if (ratio < 0.2 || ratio > 0.7) return true;
  }
  // Stricter pass: require at least 2 real word-shaped tokens OR a document
  // noun (report, spec, brief, memo, agenda, plan, list, notes, quote,
  // invoice, proposal, summary, comparison, guide, sheet, doc). A single
  // conversational token like "Cool", "Sure", "Convert" as the whole
  // filename is almost always Whisper hearing filler as the doc name.
  const words = t.split(/[\s_-]+/).filter(Boolean);
  const documentNoun = /(report|spec|specs|brief|memo|agenda|plan|list|notes?|quote|invoice|proposal|summary|comparison|compare|guide|sheet|doc|overview|analysis|breakdown|roadmap|checklist|contract|agreement|policy|resume|cv|readme|minutes|recap)/i;
  if (words.length < 2 && !documentNoun.test(t)) return true;
  return false;
}

function pickDisplayFilename(rawFilename: string, title: string, markdown: string): string {
  const sanitize = (s: string) =>
    s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const candidates: string[] = [];
  if (!looksLikeVoiceGarbageFilename(rawFilename)) candidates.push(rawFilename);
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1 && !looksLikeVoiceGarbageFilename(h1)) candidates.push(h1);
  if (title && !looksLikeVoiceGarbageFilename(title)) candidates.push(title);
  for (const c of candidates) {
    const cleaned = sanitize(c);
    if (cleaned) return cleaned;
  }
  return "Document";
}

export const generateAndStoreDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        format: z.enum(["pdf", "docx", "xlsx", "csv"]),
        filename: z.string().min(1).max(120),
        title: z.string().min(1).max(200),
        markdown: z.string().min(1).max(200000),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { generateDocument } = await import("@/lib/document-generator.server");
    const { bytes, mimeType, extension } = await generateDocument({
      format: data.format,
      title: data.title,
      markdown: data.markdown,
    });
    // Voice-driven flows sometimes hand us a misheard non-word as the
    // filename (e.g. "Underwordog", "Crash"). Reject anything that looks
    // like conversational noise or gibberish and fall back to the real
    // document title / H1 so files stay searchable and shareable.
    const displayName = pickDisplayFilename(data.filename, data.title, data.markdown);
    const slugName = displayName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const path = `generated/${context.userId}/${Date.now().toString(36)}/${slugName}.${extension}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const up = await supabaseAdmin.storage
      .from("chat-uploads")
      .upload(path, bytes, { contentType: mimeType, upsert: false });
    if (up.error) throw new Error(up.error.message);
    const signed = await supabaseAdmin.storage
      .from("chat-uploads")
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signed.error) throw new Error(signed.error.message);
    // base64 for immediate client-side preview
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    return {
      url: signed.data.signedUrl,
      filename: `${displayName}.${extension}`,
      mimeType,
      size: bytes.byteLength,
      base64,
      formatLabel:
        extension === "pdf" ? "PDF" : extension === "docx" ? "Word" : extension === "xlsx" ? "Excel" : "CSV",
    };
  });