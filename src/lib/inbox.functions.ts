import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getMicrosoftAccessToken } from "@/lib/ms-graph.server";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { z } from "zod";

export type InboxMessage = {
  id: string;
  subject: string;
  from: { name: string; email: string };
  preview: string;
  receivedAt: string;
  isRead: boolean;
  webLink: string | null;
};

export const listInboxMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ messages: InboxMessage[]; connected: boolean }> => {
    const ms = await getMicrosoftAccessToken(context.userId);
    if (!ms) return { messages: [], connected: false };

    const r = await fetch(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=25&$select=id,subject,from,bodyPreview,receivedDateTime,isRead,webLink&$orderby=receivedDateTime desc",
      { headers: { Authorization: `Bearer ${ms.accessToken}` } },
    );
    if (!r.ok) return { messages: [], connected: true };
    const j = (await r.json()) as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { name?: string; address?: string } };
        bodyPreview?: string;
        receivedDateTime: string;
        isRead?: boolean;
        webLink?: string;
      }>;
    };
    return {
      connected: true,
      messages: (j.value ?? []).map((m) => ({
        id: m.id,
        subject: m.subject ?? "(no subject)",
        from: {
          name: m.from?.emailAddress?.name ?? "",
          email: m.from?.emailAddress?.address ?? "",
        },
        preview: (m.bodyPreview ?? "").slice(0, 200),
        receivedAt: m.receivedDateTime,
        isRead: m.isRead ?? true,
        webLink: m.webLink ?? null,
      })),
    };
  });

const TriageInput = z.object({
  messageId: z.string(),
  instruction: z.string().min(1).max(500),
});

/**
 * Turn a natural-language instruction ("draft a polite decline", "archive",
 * "forward to Randy") into an action against a specific inbox message.
 * Uses the same LLM to interpret intent, then executes via Graph.
 */
export const triageInboxMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => TriageInput.parse(data))
  .handler(async ({ data, context }): Promise<{ result: string; draft?: string }> => {
    const ms = await getMicrosoftAccessToken(context.userId);
    if (!ms) return { result: "Microsoft not connected. Connect Outlook in Settings first." };

    // Fetch full message
    const mr = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${data.messageId}?$select=subject,from,body,bodyPreview`,
      { headers: { Authorization: `Bearer ${ms.accessToken}` } },
    );
    if (!mr.ok) return { result: `Couldn't load that message (${mr.status}).` };
    const msg = (await mr.json()) as {
      subject?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      body?: { content?: string };
      bodyPreview?: string;
    };

    const instruction = data.instruction.toLowerCase().trim();

    // Quick keyword routing for common ops (no LLM round-trip)
    if (/^(archive|move to archive)\b/.test(instruction)) {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${data.messageId}/move`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ms.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ destinationId: "archive" }),
        },
      );
      return { result: r.ok ? "Archived." : `Archive failed (${r.status}).` };
    }
    if (/^(delete|trash|bin)\b/.test(instruction)) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${data.messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ms.accessToken}` },
      });
      return { result: r.ok ? "Deleted." : `Delete failed (${r.status}).` };
    }
    if (/^(mark (as )?read|read)\b/.test(instruction)) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${data.messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${ms.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isRead: true }),
      });
      return { result: r.ok ? "Marked as read." : `Failed (${r.status}).` };
    }

    // Otherwise: draft a reply matching the instruction
    const key = process.env.LOVABLE_API_KEY;
    if (!key) return { result: "AI not configured." };
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("openai/gpt-5.5");

    const prompt = `You are BPA Bot drafting an email reply on behalf of the user.

Original email:
From: ${msg.from?.emailAddress?.name} <${msg.from?.emailAddress?.address}>
Subject: ${msg.subject}

${(msg.body?.content ?? msg.bodyPreview ?? "").replace(/<[^>]+>/g, " ").slice(0, 3000)}

---

User instruction: "${data.instruction}"

Write the reply body only — no subject line, no "Draft:" prefix, no explanation. Sign off as the user. Keep it professional and human, matching the requested tone.`;

    try {
      const { text } = await generateText({ model, prompt });
      return {
        result: "Draft ready — review and send from the chat.",
        draft: text.trim(),
      };
    } catch (e) {
      return { result: `Draft failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });