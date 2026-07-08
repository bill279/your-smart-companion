# BPA Bot — Handover

**Prepared for:** Randy
**Last updated:** July 8, 2026

This document summarizes the current state of BPA Bot, what changed in the recent hardening pass, how it works end-to-end, and what to watch for in day-to-day use.

---

## 1. What BPA Bot is

BPA Bot is a chat + voice assistant for BP Automation. It runs as a web app with:

- **Chat mode** — text conversation with file attachments (images, PDFs, docs).
- **Voice mode** — realtime voice conversation with the same tool access as chat.
- **Document generation** — the bot can produce branded PDF, DOCX, XLSX, CSV, and TXT files and email them.
- **Integrations** — Google Calendar, Microsoft 365 (mail/calendar), contacts, knowledge base, inbox, and an MCP server surface.

Backend: Lovable Cloud (Supabase — Postgres + Auth + Storage + Realtime).
Frontend: TanStack Start (React 19, Vite 7, Tailwind v4).
AI: Lovable AI Gateway.

---

## 2. Recent hardening pass (what was fixed)

These are the concrete improvements shipped in the last round of work, in the order they were reported.

### 2.1 Document generation
- **Consistent template across every format.** PDF, DOCX, XLSX, CSV, and TXT all use the same branded title block (BPA navy `#0D4763`, Arial, brand rule under the title) and the same two-tier heading system. No more "sometimes it looks polished, sometimes it doesn't."
- **Clean titles.** The generator strips filename-style titles (`stereoscopic_cameras_for_mining.pdf` → `Stereoscopic Cameras For Mining`) and rejects conversational noise that used to leak into titles (e.g. `"No, that's fine. I want you to go with probably the best use of a camera"`).
- **Deduped title.** If the markdown body also starts with an H1, it is stripped so the branded title isn't rendered twice.
- **Uniform spacing.** 3+ blank lines collapse to a single blank; heading spacing is fixed per tier instead of drifting per document.
- **Table sizing is deterministic.** Column count picks the font size from a fixed 3-tier scale (10/9/8pt) rather than ad-hoc per document. Portrait orientation is locked unless a table genuinely needs landscape (≥ 8 cols).
- **XLSX/CSV/TXT** all open with a title header row/line so the file has context on open.

File: `src/lib/document-generator.server.ts`

### 2.2 Email delivery
- Fixed the case where the user asked for a PDF **and** a DOCX and only received two DOCX attachments. The email pipeline now honors the exact `formats` array passed by the tool call.

### 2.3 Voice mode
- **Attachments now persist.** In voice mode, uploading a PDF or image previously appeared in the composer but never got saved to the message, so it wasn't clickable in the transcript. The realtime `onMessage` closure now reads pending uploads from a ref and includes them in the persisted user message.
- **Clickable previews in the transcript.** Images render as thumbnails that open full-size; PDFs render as a branded red file card that opens in a new tab — matching chat mode.
- **Interactive composer thumbnails.** Before sending, the composer shows the actual image thumbnail or a branded PDF card with a hover-visible remove button, so you can verify what you're about to send.
- **Less false pickup.** Throat-clears and short filler ("uh", "hmm", clearing throat) are filtered before being treated as a user turn.

Files: `src/routes/_authenticated/chat.$threadId.tsx`, `src/lib/useRealtimeVoice.ts`

### 2.4 DOCX preview parity
- The in-chat DOCX preview now mirrors the actual downloaded file (branded title, heading colors, table styles). Previously the preview looked plain even though the download was branded, which was misleading.

File: `src/routes/_authenticated/chat.$threadId.tsx`

---

## 3. How the app is put together (for the next engineer)

### 3.1 Server logic
- **App-internal server calls** use `createServerFn` from `@tanstack/react-start`. Files: `src/lib/*.functions.ts`.
- **Public/webhook endpoints** live under `src/routes/api/public/*` and always verify signatures/secrets inside the handler.
- **Auth-protected server functions** use `.middleware([requireSupabaseAuth])`. The client attaches the bearer token via `src/start.ts`.

### 3.2 Document generation flow
1. The chat model calls the `generate_document` tool with `{ title, markdown, formats[] }`.
2. `src/lib/document-generator.server.ts` renders each requested format from the same markdown source, using the shared branded template.
3. If the user asked for email delivery, the bytes are attached to a message sent via the appropriate connector.

### 3.3 Voice mode flow
1. `useRealtimeVoice` opens a realtime session with the AI gateway.
2. The mic stream is voice-activity-gated to reject non-speech and very short utterances.
3. Every finalized user turn is persisted with any pending composer attachments so it renders identically to a chat-mode message.

### 3.4 Data model highlights
- Roles live in a separate `user_roles` table with a `has_role(uuid, app_role)` security-definer function — never on the profile row.
- Every public table has `GRANT`s alongside its RLS policies.

---

## 4. Known limitations / things to watch

- **Voice-mode composer thumbnails** are shown before send and clickable after send, but the model does not yet *narrate* which image or PDF you just uploaded. If parity with ChatGPT's "I see you uploaded X" is desired, that is a small prompt tweak, not an architectural change.
- **DOCX preview vs. download** now match visually, but the preview is HTML-rendered — extremely complex tables in a generated DOCX may still render slightly differently in Word than in the preview.
- **Email attachments** are capped by the underlying provider (Google/MS) attachment limits; the app does not currently chunk very large attachments.

---

## 5. Operations

- **Preview URL:** provided in the Lovable project.
- **Publishing:** use the Publish action inside Lovable. The published site serves at `project--<id>.lovable.app`; the preview at `project--<id>-dev.lovable.app`.
- **Secrets:** managed through Lovable Cloud. Do not commit keys. `SUPABASE_SERVICE_ROLE_KEY` is not exposed to users on Lovable Cloud.
- **Backend admin:** open via the "View Backend" action inside Lovable.

---

## 6. Contact

For questions about this handover or the recent changes, reply in the Lovable chat used to build this project — the full change history is preserved there.
