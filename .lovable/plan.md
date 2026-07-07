## Build plan: 8 improvements

Shipping Tier 1 + Tier 2 from the previous list. Grouping by shared surface so we don't rewrite the same files repeatedly.

### Batch A — System prompt & tool behavior (chat.ts)
1. **Proactive follow-through** — After any `send_email`, `schedule_meeting`, or doc generation tool call, the bot must automatically propose the next logical action (calendar hold after email, prep note after meeting, follow-up reminder after send) instead of ending with "want me to?"
4. **Contact enrichment on the fly** — When a new person's name/email appears in conversation, the bot silently calls `web_search` for a bio and stashes it via `remember_fact` without narrating it, so it's available for later drafts.

### Batch B — New scheduled feature (morning briefing)
2. **Morning briefing** — New `src/routes/api/public/hooks/morning-briefing.ts` cron endpoint. Runs daily 7am per user's timezone (stored via `remember_fact`). Composes: today's calendar, unreplied emails >24h old, top 3 saved lessons. Delivered as a new assistant message in a pinned "Daily Briefing" thread per user. Requires: `pg_cron` job, new `user_briefing_prefs` table (user_id, timezone, enabled, briefing_thread_id), GRANTs + RLS.

### Batch C — New route (email triage)
3. **Email triage inbox** — New route `src/routes/_authenticated/inbox.tsx`. Lists recent Gmail messages (via existing Gmail connector), each row has a natural-language input: "draft a polite decline", "archive", "forward to Randy". Submissions call a new `triageEmail` server fn that reuses the chat agent's tools. Sidebar link added.

### Batch D — Chat UX polish
5. **Streaming status placeholders** — In `chat.$threadId.tsx`, subscribe to AI SDK tool-call events and render live status pills ("Searching the web…", "Reading your calendar…", "Drafting email…") tied to actual tool invocations, replacing the generic "Thinking…".
6. **Attachment intelligence** — Composer already accepts files. Add auto-extraction: PDFs → text via `pdf-parse`, images → vision model description via Lovable AI. Extracted content is injected into the user message with a `[Attached: filename.pdf]` header, and the bot proactively offers next actions ("want me to summarize / extract action items / draft a reply?").

### Batch E — Voice + Weekly review
7. **Voice mode** — Replace current voice implementation (if any) with OpenAI realtime via Lovable AI Gateway. New `src/components/VoiceButton.tsx` opens a WebRTC session to the gateway's realtime endpoint. Removes any ElevenLabs/other-vendor code if still present.
8. **Weekly review** — Second cron job (Sundays 6pm user TZ). Same infra as #2 but summarizes the week: meetings held, emails sent, decisions made, open follow-ups. Posts to the same "Daily Briefing" thread (or a "Weekly Review" thread — will pick one to keep it simple).

### Order of execution
1. Batch A (fastest, biggest UX lift, no schema)
2. Batch B infra (migration + cron) — unlocks #8
3. Batch D (chat polish)
4. Batch C (new route)
5. Batch E (#8 reuses Batch B, then voice last since it's the most isolated)

### Notes
- All new server logic uses `createServerFn` or `/api/public/*` cron routes per stack conventions.
- New tables get GRANTs + RLS in the same migration.
- Self-improvement loop from earlier is untouched — these features feed *into* it (more conversations = more learning).

### What I need from you
Nothing — I have enough to build. One call-out: **Batch E #7 (voice)** — do you already have voice working today via a specific provider, or is this net new? If existing, I'll rip and replace; if new, I build from scratch. I'll assume net new unless you say otherwise.