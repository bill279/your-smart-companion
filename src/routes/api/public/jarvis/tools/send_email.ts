import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { gatewayHeaders, json } from "@/lib/jarvis-tools.server";

const Body = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  cc: z.string().email().optional(),
});

function buildRfc2822({ to, subject, body, cc }: z.infer<typeof Body>) {
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body);
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const Route = createFileRoute("/api/public/jarvis/tools/send_email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
        const token = auth.slice(7);

        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const { data: claims, error: cerr } = await supabase.auth.getClaims(token);
        if (cerr || !claims?.claims?.sub) return json({ error: "unauthorized" }, 401);

        const parsed = Body.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) return json({ error: parsed.error.message }, 400);
        const data = parsed.data;

        // Prefer Gmail if connected, fall back to Outlook.
        if (process.env.GOOGLE_MAIL_API_KEY) {
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
          if (!res.ok) return json({ error: `gmail send failed (${res.status})`, detail: text.slice(0, 300) }, 502);
          return json({ ok: true, provider: "gmail" });
        }

        if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
          const payload = {
            message: {
              subject: data.subject,
              body: { contentType: "Text", content: data.body },
              toRecipients: [{ emailAddress: { address: data.to } }],
              ...(data.cc
                ? { ccRecipients: [{ emailAddress: { address: data.cc } }] }
                : {}),
            },
          };
          const res = await fetch(
            "https://connector-gateway.lovable.dev/microsoft_outlook/me/sendMail",
            {
              method: "POST",
              headers: gatewayHeaders("MICROSOFT_OUTLOOK_API_KEY"),
              body: JSON.stringify(payload),
            },
          );
          if (!res.ok) {
            const text = await res.text();
            return json({ error: `outlook send failed (${res.status})`, detail: text.slice(0, 300) }, 502);
          }
          return json({ ok: true, provider: "outlook" });
        }

        return json({ error: "No email provider connected. Connect Gmail or Outlook in integrations." }, 503);
      },
    },
  },
});