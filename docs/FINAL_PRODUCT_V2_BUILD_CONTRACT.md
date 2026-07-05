# BPA Bot final product build contract

This document defines the product we should ship. The current app proved the concept, but the final product should not be a patched voice prototype.

## Product standard

BPA Bot should feel like ChatGPT / Claude in chat quality, with a better business-action layer:

- Voice and chat stay perfectly in sync.
- The assistant can talk naturally without losing the written answer.
- The assistant can send Outlook emails after approval.
- The assistant can create calendar events after approval.
- The assistant can generate PDFs, Word docs, Excel files, CSVs, and Markdown files.
- The assistant can research the web with citations.
- The assistant can use contacts, memory, and company knowledge.
- The mobile pinned-app experience feels clean and reliable.

If voice feels glitchy, repetitive, laggy, or disconnected from chat, the product is not done.

## Keep from the current build

These parts are useful and should be retained:

- Supabase auth, storage, chat history, contacts, memory, and action logs
- Vercel deployment
- Outlook OAuth and Microsoft Graph integration
- Document generation pipeline
- File/artifact cards
- Quality Lab
- PWA/mobile install setup
- Client handoff SOP
- Chat tools: web search, scrape, image search, Outlook, calendar, contacts, memory, knowledge base, document generation

## Replace / rebuild

The current voice layer should be replaced.

Do not keep patching two competing brains:

- Realtime voice brain
- Chat/tool brain

That split is why voice feels inconsistent.

## Final voice architecture

Voice should be a transport layer, not the main brain.

### Source of truth

The chat thread is the source of truth.

Every voice interaction should follow this flow:

1. User speaks.
2. Speech is transcribed.
3. Final transcript is inserted into chat.
4. Main chat agent generates the real answer and tool actions.
5. Full answer appears in chat.
6. A short spoken version is generated from that answer.
7. Voice speaks the short version.

There should be one reasoning path: the main chat agent.

### Realtime voice responsibilities

Realtime voice should only handle:

- microphone capture
- speech-to-text
- interruption / stop speaking
- text-to-speech playback
- low-latency conversational feel

Realtime voice should not independently decide to:

- send emails
- create calendar events
- generate PDFs
- claim something is “on screen”
- make product recommendations
- produce source-backed research

Those belong to the main chat agent.

## Required voice behavior

Voice must:

- Update the chat in real time while the user speaks.
- Keep the final transcript visible.
- Keep the assistant answer visible.
- Not jump back to the empty homepage state mid-conversation.
- Stop speaking immediately when interrupted.
- Never answer half-phrases like “can you email…” before the user finishes.
- Never repeat the same confirmation question.
- Never say a PDF/table/link is created unless it is actually visible in chat.
- Speak short summaries, not long tables or full documents.

## Email behavior

Email must be deterministic and safe:

1. User asks to email someone.
2. If recipient is known, draft immediately.
3. If user says “email me,” use the signed-in user email and do not reconfirm it.
4. If recipient is unknown, ask one focused question.
5. Show full draft preview.
6. Wait for approval.
7. On “send,” send once.
8. Never ask for the same approval again.
9. Never send on the initial request.

## Document behavior

Document generation must be deterministic:

- If the user asks for PDF, Word, Excel, CSV, Markdown, report, export, attachment, or download, create the file.
- Do not paste document content as a normal answer.
- Do not say the assistant cannot create files.
- Return a file card with Open, Download, and Copy Link.

## Research behavior

Research must be useful and visible:

- Current info requires web search.
- Product/vendor comparisons require a Markdown table.
- Source-backed claims need clickable links.
- Unknown specs should say `Not published` or `Needs verification`.
- Never say “links are on screen” unless links are actually in the answer.

## Mobile/PWA behavior

The app should:

- Open directly to chat.
- Have a clean mobile header.
- Respect iPhone safe areas.
- Work as an Add to Home Screen app.
- Keep mic/composer controls reachable.
- Avoid dashboard-like clutter in the default user flow.

## Quality gate

The final product is not accepted until Quality Lab passes 9/9:

1. Voice does not answer fragments.
2. Email confirmation happens once.
3. PDF generation is direct.
4. Comparison answers are structured.
5. Current web research is decisive.
6. Tables and links actually render.
7. Unclear audio repair is professional.
8. Calendar actions are safe.
9. Voice sounds polished, not chatty.

Manual iPhone checks are also required:

- Short voice question.
- Long voice request.
- Voice interruption.
- PDF generation.
- Email draft and send.
- Calendar draft and create.
- Web research with links.

## Implementation plan

### Phase 1 — stabilize architecture

- Create a single `agentAnswer` backend route used by both chat and voice.
- Move tool decisions into that route.
- Make voice call `agentAnswer` after final transcript.
- Make voice speak a short summary of the returned answer.
- Remove independent tool execution from realtime voice except transcription/TTS support.

### Phase 2 — polish UX

- Make chat streaming stable during voice.
- Keep local optimistic transcript bubbles until database state catches up.
- Make mobile layout feel native.
- Make artifact cards reliable on iPhone.

### Phase 3 — client readiness

- Replace test-owned keys/accounts with client-owned accounts.
- Run Quality Lab.
- Run manual iPhone tests.
- Hand off SOP to client IT.

## Decision

Stop treating the current voice system as the final product.

Use the current app as the foundation, but rebuild voice around one source of truth: the main chat agent.

