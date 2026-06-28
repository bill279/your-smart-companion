import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const KB_ALLOWED = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
];
const KB_MAX_BYTES = 20 * 1024 * 1024;
const EMBED_MODEL = "openai/text-embedding-3-small";

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

// ---------- helpers (server-only) ----------
async function extractText(buf: ArrayBuffer, mime: string, name: string): Promise<string> {
  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n\n") : text;
  }
  // Treat everything else as utf-8 text (txt / md / csv)
  return new TextDecoder("utf-8").decode(buf);
}

function chunkText(text: string, target = 1200, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= target) return clean.length > 0 ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + target, clean.length);
    if (end < clean.length) {
      // try to break on paragraph or sentence
      const slice = clean.slice(i, end);
      const lastPara = slice.lastIndexOf("\n\n");
      const lastSent = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
      const breakAt = lastPara > target * 0.5 ? lastPara : lastSent > target * 0.5 ? lastSent + 1 : -1;
      if (breakAt > 0) end = i + breakAt;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("AI gateway not configured");
  const r = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Embedding failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
  return j.data.map((d) => d.embedding);
}

// ---------- server functions ----------
export const createKbUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        name: z.string().min(1).max(200),
        mimeType: z.string().min(1),
        size: z.number().int().min(1).max(KB_MAX_BYTES),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    if (!KB_ALLOWED.includes(data.mimeType) && !data.name.toLowerCase().endsWith(".pdf")) {
      throw new Error(`Unsupported file type: ${data.mimeType}. Use PDF, TXT, MD, or CSV.`);
    }
    const path = `${context.userId}/${Date.now()}-${sanitize(data.name)}`;
    const { data: signed, error } = await context.supabase.storage
      .from("kb-files")
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { path, token: signed.token, signedUrl: signed.signedUrl };
  });

export const ingestKbDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        path: z.string().min(1),
        name: z.string().min(1).max(200),
        mimeType: z.string().min(1),
        size: z.number().int().min(1).max(KB_MAX_BYTES),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    // Insert doc row
    const { data: doc, error: insErr } = await supabase
      .from("kb_documents")
      .insert({
        user_id: userId,
        name: data.name,
        storage_path: data.path,
        mime_type: data.mimeType,
        size_bytes: data.size,
        status: "processing",
      })
      .select("id")
      .single();
    if (insErr || !doc) throw new Error(insErr?.message ?? "Insert failed");
    const docId = doc.id;

    try {
      const dl = await supabase.storage.from("kb-files").download(data.path);
      if (dl.error || !dl.data) throw new Error(dl.error?.message ?? "Download failed");
      const buf = await dl.data.arrayBuffer();
      const text = await extractText(buf, data.mimeType, data.name);
      if (!text.trim()) throw new Error("No text could be extracted from this file.");
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error("File produced no chunks.");

      // Embed in batches of 32
      const BATCH = 32;
      let inserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vectors = await embedBatch(batch);
        const rows = batch.map((content, j) => ({
          document_id: docId,
          user_id: userId,
          chunk_index: i + j,
          content,
          embedding: vectors[j] as unknown as string, // pgvector accepts JSON-array string
        }));
        const { error: chunkErr } = await supabase.from("kb_chunks").insert(rows as never);
        if (chunkErr) throw new Error(chunkErr.message);
        inserted += rows.length;
      }

      await supabase
        .from("kb_documents")
        .update({ status: "ready", chunk_count: inserted, error: null })
        .eq("id", docId);
      return { ok: true, id: docId, chunks: inserted };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase
        .from("kb_documents")
        .update({ status: "error", error: msg })
        .eq("id", docId);
      throw new Error(msg);
    }
  });

export const listKbDocuments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("kb_documents")
      .select("id,name,mime_type,size_bytes,status,error,chunk_count,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const deleteKbDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: row } = await supabase
      .from("kb_documents")
      .select("storage_path")
      .eq("id", data.id)
      .maybeSingle();
    if (row?.storage_path) {
      await supabase.storage.from("kb-files").remove([row.storage_path]);
    }
    const { error } = await supabase.from("kb_documents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });