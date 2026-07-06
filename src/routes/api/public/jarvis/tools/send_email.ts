import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { gatewayHeaders, json } from "@/lib/jarvis-tools.server";
import { marked } from "marked";

const Body = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  cc: z.string().email().optional(),
  attachment: z
    .object({
      filename: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(200),
      // ~15MB of base64 ≈ 11MB file. Gmail attachment limit is 25MB via API.
      contentBase64: z.string().min(1).max(20_000_000),
    })
    .optional(),
});

function renderEmailHtml(markdown: string) {
  const inner = marked.parse(markdown, { gfm: true, breaks: true, async: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;margin:0;padding:24px;background:#ffffff;}
    .container{max-width:640px;margin:0 auto;}
    h1,h2,h3{color:#0b2545;margin:1.2em 0 .4em;}
    p{margin:.6em 0;}
    a{color:#0b6e3f;}
    code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}
    pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;overflow:auto;}
    pre code{background:transparent;padding:0;color:inherit;}
    blockquote{border-left:3px solid #0b6e3f;margin:.8em 0;padding:.2em 0 .2em 12px;color:#334155;}
    ul,ol{padding-left:22px;}
    table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;}
    th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top;}
    th{background:#0b2545;color:#ffffff;font-weight:600;}
    tr:nth-child(even) td{background:#f8fafc;}
    hr{border:none;border-top:1px solid #e2e8f0;margin:18px 0;}
  </style></head><body><div class="container">${inner}</div></body></html>`;
}

function buildRfc2822({ to, subject, body, cc, attachment }: z.infer<typeof Body>) {
  const html = renderEmailHtml(body);
  const lines = [`To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`, "MIME-Version: 1.0");

  const altBoundary = `bpa_alt_${Math.random().toString(36).slice(2)}`;
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
    "",
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    "",
    `--${altBoundary}--`,
  ].join("\r\n");

  if (attachment) {
    const mixedBoundary = `bpa_mix_${Math.random().toString(36).slice(2)}`;
    // Base64 body must be line-wrapped to 76 chars for RFC compliance.
    const wrapped = attachment.contentBase64.replace(/(.{76})/g, "$1\r\n");
    lines.push(
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      "",
      `--${mixedBoundary}`,
      altPart,
      "",
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapped,
      "",
      `--${mixedBoundary}--`,
      "",
    );
  } else {
    lines.push(altPart, "");
  }
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

        // Send via Outlook.
        if (process.env.MICROSOFT_OUTLOOK_API_KEY) {
          const payload = {
            message: {
              subject: data.subject,
              body: { contentType: "HTML", content: renderEmailHtml(data.body) },
              toRecipients: [{ emailAddress: { address: data.to } }],
              ...(data.cc
                ? { ccRecipients: [{ emailAddress: { address: data.cc } }] }
                : {}),
              ...(data.attachment
                ? {
                    attachments: [
                      {
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        name: data.attachment.filename,
                        contentType: data.attachment.mimeType,
                        contentBytes: data.attachment.contentBase64,
                      },
                    ],
                  }
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
        return json({ error: "Outlook is not connected." }, 503);
      },
    },
  },
});