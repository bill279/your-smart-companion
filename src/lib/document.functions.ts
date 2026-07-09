import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
    // Display filename keeps spaces + human casing (e.g. "Q4 Sales Report.pdf").
    // The storage path uses a slug variant so URLs stay clean.
    const displayName = data.filename
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Document";
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