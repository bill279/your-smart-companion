# BPA Bot client handoff SOP

This document is the setup checklist for handing BPA Bot to a client IT team.

## What BPA Bot does

BPA Bot is a web app / mobile-installable assistant for:

- Chat and voice conversations through OpenAI
- Live web research with citations
- Outlook email search, drafting, and approved sending
- Calendar previews and approved event creation
- PDF, Word, Excel, CSV, Markdown, and text document generation
- Saved contacts, memory, and company knowledge search

The app is designed to behave like a polished assistant: it drafts before sending, asks for approval once, and provides downloadable document cards instead of making users copy/paste content.

## Production ownership

Before client launch, decide who owns each system:

| System | Recommended owner | Notes |
| --- | --- | --- |
| GitHub repo | Client or managed vendor | Client should have admin access before go-live. |
| Vercel project | Client IT | Hosts the production web app. |
| Supabase project | Client IT | Stores users, chats, files, contacts, memory, and integration tokens. |
| OpenAI API key | Client IT / finance owner | Controls chat, voice, web search, embeddings, and document intelligence cost. |
| Microsoft Azure app registration | Client Microsoft 365 admin | Required for Outlook/email/calendar sign-in. |
| Domain/DNS | Client IT | Optional but recommended for a client-branded URL. |

## Required environment variables

Required for core production:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Chat, voice/realtime, embeddings, web search, and document flows. |
| `SUPABASE_URL` | Yes | Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | Browser/server Supabase auth access. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes for admin/server tasks | Server-side privileged Supabase actions. Keep secret. |
| `MICROSOFT_TENANT_ID` | Yes for Microsoft 365 client launch | Tenant-specific Microsoft OAuth endpoint. Avoid `/common` unless the app is multi-tenant. |

Optional / legacy / advanced:

| Variable | Required | Purpose |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | Optional | Web scrape and image search fallback. |
| `OPENAI_WEB_SEARCH_MODEL` | Optional | Override default OpenAI web search model. |
| `JARVIS_TOOL_SECRET` | Optional | Protects public tool endpoints if used. |
| `LOVABLE_API_KEY` | Legacy optional | Only needed for old Lovable proxy/tool fallback paths. Not required for Vercel-first deployment. |
| `MICROSOFT_OUTLOOK_API_KEY` | Legacy optional | Old Outlook fallback path. Modern OAuth token flow is preferred. |
| `GOOGLE_MAIL_API_KEY` | Optional legacy | Gmail fallback if enabled later. |
| `GOOGLE_CALENDAR_API_KEY` | Optional legacy | Google Calendar fallback if enabled later. |
| `DATABASE_URL` | Optional | Only needed for tooling that connects directly to Postgres. |
| `STRIPE_SECRET_KEY` | Optional | Only needed if billing is added. |

Never commit `.env`, `.env.local`, API keys, OAuth secrets, service role keys, or client secrets to Git.

## Microsoft setup

Create an Azure App Registration in the client tenant.

Minimum recommended Microsoft Graph delegated permissions:

- `openid`
- `profile`
- `email`
- `offline_access`
- `User.Read`
- `Mail.Read`
- `Mail.Send`
- `Calendars.ReadWrite`

Redirect URI:

- `https://CLIENT_DOMAIN/api/integrations/microsoft/callback`

For the current Vercel production URL, use:

- `https://your-smart-companion-kappa.vercel.app/api/integrations/microsoft/callback`

Important:

- If the Azure app is single-tenant, set `MICROSOFT_TENANT_ID` to the tenant ID.
- Do not use `/common` for a single-tenant app; Microsoft will reject it with `AADSTS50194`.
- After changing scopes or tenant settings, reconnect Outlook inside BPA Bot settings.

## OpenAI setup

Use a client-owned OpenAI Platform account and API key.

Recommended controls:

- Set monthly usage limits.
- Keep the key only in Vercel environment variables.
- Rotate the key before client launch if a test key was used during development.
- Monitor realtime voice usage separately because voice can spend faster than text chat.

## Supabase setup

Client IT should own the Supabase project.

Required Supabase pieces:

- Auth enabled
- Storage bucket for generated and uploaded files
- Database tables for chats/messages/settings/memory/contacts/actions/integration tokens
- Row-level security policies

Before handoff, verify:

- New user can sign in.
- Chat thread is created.
- Generated PDF produces a downloadable file card.
- Outlook token can be stored and refreshed.
- Disconnect/reconnect Outlook works.

## Vercel setup

1. Import the GitHub repo.
2. Set production environment variables.
3. Deploy production.
4. Configure custom domain if needed.
5. Verify these routes return 200:
   - `/chat`
   - `/dashboard`
   - `/settings`
   - `/quality`

## Mobile app install

On iPhone:

1. Open the production URL in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch BPA Bot from the home screen icon.
5. Grant microphone permission when using voice.

The PWA starts at `/chat` and uses standalone display mode.

## Acceptance tests

Run the built-in Quality Lab after every major prompt, voice, email, or document change.

Target: 9/9 passing.

Scenarios:

1. Voice does not answer fragments.
2. Email confirmation happens once.
3. PDF generation is direct.
4. Comparison answers are structured.
5. Current web research is decisive.
6. Tables and links actually render.
7. Unclear audio repair is professional.
8. Calendar actions are safe.
9. Voice sounds polished, not chatty.

If a scenario fails, fix the specific failure before adding new features.

## Email and signature behavior

Microsoft Graph sends email directly through the account, but it usually does not apply the Outlook desktop/web compose signature.

Recommended policy:

- BPA Bot should include a professional sign-off in the email body.
- If the client uses an Exchange/server-side signature, it may append separately.
- For launch, ask the client what default sign-off they want and save it as assistant memory, such as:
  - `preferred_signoff = Best regards, [Name]`

## Go-live checklist

- Client-owned OpenAI key added to Vercel.
- Client-owned Supabase project connected.
- Client-owned Microsoft app registration connected.
- Outlook reconnect tested by the final user.
- Email draft → approval → send tested.
- Calendar preview → approval → create tested.
- PDF generation tested on desktop and iPhone.
- Voice tested on iPhone home-screen app.
- Quality Lab passes.
- Domain configured.
- Test keys rotated.
- SOP shared with client IT.
