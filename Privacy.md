# Privacy Policy

**Meeting Availability Assistant** helps users propose meeting times directly from Gmail.

## Data Collected

| Data | Purpose | Stored? |
|------|---------|---------|
| Google account email | Identify your account on our backend | Yes — on our server |
| Google OAuth token | Authenticate requests to our backend and Google APIs | In memory only, never persisted |
| Email subject, sender, body (up to 2,000 chars) | Detect meeting requests and draft replies | Sent to Anthropic Claude API; not stored by us |
| Google Calendar free/busy intervals | Suggest open time slots | Not stored; used only to compute suggestions |
| Display name (optional) | Sign AI-drafted replies | Stored locally on your device |
| Anthropic API key (optional, BYOK) | Route Claude calls directly from your browser | Stored locally on your device only — never synced or sent to our servers |

## External Services Used

When you use the free tier, email content is sent to:

- **Anthropic Claude API** (`api.anthropic.com`) — to detect meeting intent and draft replies. See [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).
- **Our backend** (Supabase Edge Function) — to authenticate your account, check your usage quota, and relay requests to Claude. Your Google email is stored to track your tier and monthly usage.
- **Google APIs** (`googleapis.com`) — to read your calendar availability and verify your identity.

When you use "Bring Your Own API Key" (BYOK), email content is sent directly from your browser to the Anthropic API using your key. Our backend is not involved.

## Data Retention

- **Usage counts** are stored per-month and are used solely to enforce the free tier limit.
- **Email content** is never stored by us. It is transmitted to Anthropic for processing and subject to Anthropic's data retention policies.
- You can delete your account data by contacting us at the address below.

## Data Sharing

We do **not** sell or share your data with third parties beyond the services listed above, which are necessary to provide the extension's functionality.

## Security

- Your optional Anthropic API key is stored only in your browser's local storage and is never transmitted to our servers.
- All network communication uses HTTPS.

## Changes

If this privacy policy changes, the updated version will be posted here.

## Contact

If you have questions about this privacy policy, please contact:
**support@[yourdomain].com**
