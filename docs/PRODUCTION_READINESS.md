# BPA Bot production readiness notes

## Current production priorities

The app is usable, but before calling it client-ready, keep pressure on these areas:

1. Voice reliability on iPhone
   - Long voice turns should keep chat text visible.
   - The app should not jump back to the empty state.
   - The assistant should not repeat confirmations.

2. Email safety
   - First request creates a draft.
   - Approval sends once.
   - Cancellation never sends.
   - "Email me" uses the signed-in user's email without reconfirming it.

3. Document reliability
   - PDF/DOCX/XLSX generation returns a file card.
   - Open and Download both work.
   - iPhone users should prefer Download if preview is inconsistent.

4. Research quality
   - Current facts require sources.
   - Product comparisons need actual Markdown tables.
   - Unknown specs should be marked `Not published` or `Needs verification`.

5. Client deployment
   - Replace all test-owned accounts with client-owned OpenAI, Microsoft, Supabase, Vercel, and domain ownership.

## Known product decisions

- Vercel-first deployment is preferred over Lovable for production to avoid ongoing Lovable credit dependency.
- Lovable can remain useful for prototyping, but production should not rely on Lovable credits.
- Outlook/Microsoft is the primary email/calendar path.
- Gmail/Google paths are optional legacy/future expansion.
- Voice uses OpenAI Realtime, not ElevenLabs.

## Regression checklist after each deploy

Run:

- TypeScript check
- Vercel production build
- `/chat` smoke check
- `/dashboard` smoke check
- Quality Lab

Manual phone checks:

- Install/open from iPhone home screen.
- Start voice.
- Ask a short question.
- Ask a long research/comparison question.
- Generate a PDF.
- Draft an email and approve send.

