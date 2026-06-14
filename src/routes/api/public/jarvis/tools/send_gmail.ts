import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json, gatewayHeaders } from "@/lib/jarvis-tools.server";

function buildRfc2822({ to, subject, body, cc }: { to: string; subject: string; body: string; cc?: string }) {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body);
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const Route = createFileRoute("/api/public/jarvis/tools/send_gmail")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = checkSecret(request);
        if (unauth) return unauth;
        const data = await readJson(
          request,
          z.object({
            to: z.string().email(),
            subject: z.string().min(1).max(200),
            body: z.string().min(1).max(20000),
            cc: z.string().optional(),
          }),
        );
        const raw = buildRfc2822(data);
        const res = await fetch(
          "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: gatewayHeaders("GOOGLE_MAIL_API_KEY"),
            body: JSON.stringify({ raw }),
          },
        );
        const text = await res.text();
        if (!res.ok) return json({ error: `gmail send failed (${res.status}): ${text}` }, 502);
        return json({ ok: true, id: JSON.parse(text).id });
      },
    },
  },
});