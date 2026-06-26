import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ALLOWED = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
];
const MAX_BYTES = 20 * 1024 * 1024;

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export const createChatUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        threadId: z.string().uuid(),
        name: z.string().min(1).max(200),
        mimeType: z.string().min(1),
        size: z.number().int().min(1).max(MAX_BYTES),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    if (!ALLOWED.includes(data.mimeType)) {
      throw new Error(`Unsupported file type: ${data.mimeType}`);
    }
    const path = `${context.userId}/${data.threadId}/${Date.now()}-${sanitize(data.name)}`;
    const { data: signed, error } = await context.supabase.storage
      .from("chat-uploads")
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { path, token: signed.token, signedUrl: signed.signedUrl };
  });