# BPA Bot — Quality & Capability Pass

Addressing your feedback in priority order. Grouped so we can ship incrementally.

## 1. Speed up perceived response time
- Switch the default chat model from Gemini 2.5 Pro to **Gemini 2.5 Flash** for first-token speed; keep Pro as fallback for heavy reasoning (knowledge base / multi-tool chains).
- Stream tokens to the UI as soon as they arrive (we already stream — verify no buffering on the markdown renderer; flush every chunk instead of awaiting paragraphs).
- Trim the system prompt (it's ~5K tokens now). Move tool usage rules into per-tool descriptions so they only load when relevant.

## 2. Better chat formatting (ChatGPT/Claude quality)
- Rewrite the response style section of the system prompt to enforce:
  - Short paragraphs (max 3 sentences)
  - Headings (`##`) for any answer >150 words
  - Bullets / numbered steps by default
  - Tables for any comparison
  - Bold for key terms, inline code for values
  - Callouts (`> Note:`) for warnings
- Upgrade the markdown renderer with `remark-gfm` + `rehype-highlight` so tables, task lists, and code blocks render cleanly.
- Add typography polish: tighter line-height, proper list spacing, table zebra-striping.

## 3. Fix voice breaking on long conversations
Root cause: ElevenLabs agent context window overflows when chat history + long assistant replies stack up.

- Cap voice-mode replies to ~80 words via a separate "voice system prompt" appended only when in voice mode.
- Summarize older turns: when voice history >30 messages, replace the oldest 20 with a single summary message before sending to ElevenLabs.
- Add a hard 12-second silence keepalive ping so the socket doesn't drop mid-thought.
- Catch the "audio decode" error and auto-reconnect once instead of speaking gibberish.

## 4. Voice quality (static / glitch)
- Switch ElevenLabs output to `mp3_44100_128` (currently default lower bitrate).
- Set `optimize_streaming_latency: 2` (was 4 — too aggressive, causes artifacts).
- Verify mic sample rate is 16kHz mono; resample if browser gives 48kHz.

## 5. Tables render mid-speech as garbled text
Today: the live transcript shows raw markdown pipes while bot is speaking, then re-renders as a real table when finished.

- Detect markdown tables in the streaming buffer and **hide the partial table** (show "Generating table…" placeholder) until the closing row arrives, then render. Plain text continues streaming normally.

## 6. Document export (PDF / Word / Excel)
Add a new tool `export_document` the bot can call:
- `format`: pdf | docx | xlsx | md
- `content`: structured (sections, tables) or raw markdown
- Generates the file server-side, uploads to Supabase storage, returns a signed download link rendered as a download card in chat.
- Bot auto-suggests export when the user says "save this", "send me a copy", "make a PDF", etc.
- Libraries: `pdf-lib` (PDF), `docx` (Word), `exceljs` (Excel) — all Worker-compatible.

## 7. Calendar proactivity & async updates
- Add a `get_today_schedule` tool the bot calls automatically on first message of the day ("Good morning — you have 3 meetings today…").
- Add `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` (Google + Outlook).
- Add a daily 7am pg_cron job that emails/notifies a daily brief (opt-in toggle on the Knowledge page).
- "Remind me at 3pm to…" → creates a calendar event with a popup reminder.

## 8. Large data input
- Raise upload limit on the Knowledge page to 50MB per file.
- Accept `.csv`, `.xlsx`, `.docx` in addition to PDF/MD/TXT (parse server-side).
- For pasted long text in chat, auto-detect >4K chars and offer "Save as knowledge document" instead of sending inline.

---

## Suggested rollout order
1. **Quick wins (this turn)**: items 1, 2, 4 — model swap, prompt rewrite, voice bitrate. Biggest impact, lowest risk.
2. **Next turn**: items 3, 5 — voice stability + table streaming fix. Needs careful testing.
3. **Following turn**: item 6 — document export (new dependencies, new tool).
4. **Last**: items 7, 8 — calendar tools + large-data ingestion.

## Technical notes
- Files touched in phase 1: `src/routes/api/chat.ts` (prompt + model), `src/routes/_authenticated/chat.$threadId.tsx` (renderer + voice config), `src/lib/jarvis.functions.ts` (ElevenLabs settings), `package.json` (`remark-gfm`, `rehype-highlight`).
- Phase 3 adds: `src/lib/export.functions.ts`, `src/routes/api/public/jarvis/tools/export_document.ts`, storage bucket `exports`.
- Phase 4 adds: `src/lib/calendar.functions.ts`, calendar tool routes, pg_cron job, new `user_preferences` table for brief opt-in.

Want me to start with **Phase 1 (speed + formatting + voice quality)** now?