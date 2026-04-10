# Meeting Availability Assistant

Chrome Extension (Manifest V3) that detects meeting requests in Gmail and drafts availability replies using Claude AI + Google Calendar.

## Architecture
- `content.js` — Gmail content script. Injects toolbar button into compose formatting bar, opens floating sidebar panel for slot selection and reply insertion.
- `background.js` — Service worker. All network calls: Claude API (intent detection + reply drafting), Google Calendar freeBusy, Supabase backend proxy. Google auth via chrome.identity.
- `popup.html/js` — Extension popup showing account status, usage, sign-in.
- `options.html/js` — Settings page (BYOK API key, display name).
- `supabase/functions/` — Edge Function backend: proxies Claude calls for free-tier users, tracks usage per Google account, enforces limits.

## Key constraints
- Manifest V3 only — service worker can go idle; no background pages
- Gmail DOM is fragile — selectors can break on Gmail updates
- Content script communicates with service worker via chrome.runtime.sendMessage
- Dual API mode: BYOK (direct to Anthropic) or free/paid tier (via Supabase proxy)
- Free tier: 5 replies/month per Google account

## Slash commands
- `/code-review` — Security, correctness, and quality review
- `/design-review` — Architecture and design feedback
- `/chrome-ext` — Chrome extension specialist for implementation tasks
- `/publish` — Pre-flight checks, version bump, zip build, and Web Store submission checklist
