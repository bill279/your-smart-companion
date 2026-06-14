import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { checkSecret, readJson, json, gatewayHeaders } from "@/lib/jarvis-tools.server";

export const Route = createFileRoute("/api/public/jarvis/tools/send_outlook")({
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
            cc: z.string().email().optional(),
          }),
        );
        const payload = {
          message: {
            subject: data.subject,
            body: { contentType: "Text", content: data.body },
            toRecipients: [{ emailAddress: { address: data.to } }],
            ...(data.cc ? { ccRecipients: [{ emailAddress: { address: data.cc } }] } : {}),
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
          return json({ error: `outlook send failed (${res.status}): ${text}` }, 502);
        }
        return json({ ok: true });
      },
    },
  },
});