import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ms-oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const providerError = url.searchParams.get("error");
        const providerErrorDescription = url.searchParams.get("error_description");

        const origin = url.origin;
        const closingPage = (title: string, body: string) =>
          new Response(
            `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f19;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}.card{max-width:480px;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;line-height:1.5;margin:0 0 16px}a{color:#60a5fa;text-decoration:none}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p><p><a href="/chat">Return to BPA Bot</a></p></div></body></html>`,
            { status: providerError ? 400 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          );

        if (providerError) {
          return closingPage(
            "Microsoft sign-in was cancelled",
            `Microsoft returned: <strong>${providerError}</strong>. ${providerErrorDescription ?? ""}`,
          );
        }
        if (!code || !state) {
          return closingPage("Missing code or state", "Microsoft did not return an authorization code.");
        }

        const { verifyOauthState, exchangeCodeForToken, saveMicrosoftTokens } = await import("@/lib/ms-graph.server");
        const parsed = verifyOauthState(state);
        if (!parsed) {
          return closingPage("Session expired", "That connection link is no longer valid. Please start over from BPA Bot.");
        }

        try {
          const token = await exchangeCodeForToken(code, `${origin}/api/public/ms-oauth/callback`);
          const { ms_email } = await saveMicrosoftTokens(parsed.userId, token);
          return closingPage(
            "Microsoft connected",
            `You're all set${ms_email ? ` as <strong>${ms_email}</strong>` : ""}. BPA Bot can now send email, read your calendar, and create Teams meetings on your behalf.`,
          );
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          return closingPage("Connection failed", detail.slice(0, 500));
        }
      },
    },
  },
});