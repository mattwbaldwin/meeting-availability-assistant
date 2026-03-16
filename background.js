// background.js — service worker
// Handles all network requests (Claude API, Google Calendar, Supabase backend)

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CALENDAR_FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Replace with your deployed Supabase Edge Function URL
const BACKEND_URL = 'https://asuygmqdauyjmsufvwgz.supabase.co/functions/v1/claude-proxy';

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'CHECK_EMAIL':
          sendResponse(await checkEmail(message));
          break;
        case 'GET_CALENDAR_SLOTS':
          sendResponse(await getCalendarSlots());
          break;
        case 'DRAFT_REPLY':
          sendResponse(await draftReply(message));
          break;
        case 'GET_ACCOUNT_STATUS':
          sendResponse(await getAccountStatus());
          break;
        case 'SIGN_IN':
          await getGoogleToken(true);
          sendResponse(await getAccountStatus());
          break;
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep message channel open for async response
});

// ─── Intent Detection ─────────────────────────────────────────────────────────

async function checkEmail({ subject, from, body }) {
  // User-supplied email content is wrapped in XML tags to delimit it from
  // the trusted instruction text, reducing prompt-injection risk.
  const prompt = `Analyze the email below. Is the sender requesting to schedule a meeting or asking about calendar availability?

<email>
<subject>${subject}</subject>
<from>${from}</from>
<body>${body.slice(0, 2000)}</body>
</email>

Reply with JSON only, no other text:
{"is_availability_request": boolean, "confidence": number}`;

  const result = await callClaude(prompt, 'check_email');
  try {
    const parsed = JSON.parse(result.content[0].text.trim());
    return { success: true, ...parsed };
  } catch {
    return { success: true, is_availability_request: false, confidence: 0 };
  }
}

// ─── Reply Drafting ───────────────────────────────────────────────────────────

async function draftReply({ emailBody, selectedSlots, userName }) {
  const slotList = selectedSlots.map(s => `- ${s}`).join('\n');
  // User-supplied content wrapped in XML tags to delimit from instructions.
  const safeUserName = (userName || 'me').slice(0, 100);
  const prompt = `Draft a professional, friendly email reply proposing the following meeting times. Match the tone of the original email.

<original_email>
${emailBody.slice(0, 2000)}
</original_email>

Times to propose:
${slotList}

Sign off as: ${safeUserName}

Write only the reply body text. Do not include a subject line.`;

  const result = await callClaude(prompt, 'draft_reply');
  return { success: true, replyText: result.content[0].text.trim() };
}

// ─── Google Calendar Free/Busy ────────────────────────────────────────────────

async function getCalendarSlots() {
  const token = await getGoogleToken(true);
  const now = new Date();
  const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const res = await fetch(CALENDAR_FREEBUSY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: twoWeeksOut.toISOString(),
      items: [{ id: 'primary' }],
    }),
  });

  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  const data = await res.json();
  const busyIntervals = data.calendars?.primary?.busy || [];
  const freeSlots = computeFreeSlots(now, twoWeeksOut, busyIntervals);
  return { success: true, slots: freeSlots };
}

function computeFreeSlots(start, end, busyIntervals) {
  const SLOT_DURATION_MS = 60 * 60 * 1000; // 1 hour
  const WORK_START_HOUR = 9;
  const WORK_END_HOUR = 17;
  const slots = [];

  const busy = busyIntervals.map(b => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const cursor = new Date(start);
  // Advance to next work hour boundary
  cursor.setMinutes(0, 0, 0);
  if (cursor.getHours() < WORK_START_HOUR) cursor.setHours(WORK_START_HOUR);
  else if (cursor.getHours() >= WORK_END_HOUR) {
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(WORK_START_HOUR);
  }

  while (cursor < end && slots.length < 20) {
    const day = cursor.getDay();
    if (day === 0 || day === 6) {
      // Skip weekends
      cursor.setDate(cursor.getDate() + (day === 6 ? 2 : 1));
      cursor.setHours(WORK_START_HOUR);
      continue;
    }
    if (cursor.getHours() >= WORK_END_HOUR) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(WORK_START_HOUR);
      continue;
    }

    const slotStart = cursor.getTime();
    const slotEnd = slotStart + SLOT_DURATION_MS;

    const isBusy = busy.some(b => slotStart < b.end && slotEnd > b.start);
    if (!isBusy) {
      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
        label: formatSlotLabel(new Date(slotStart), new Date(slotEnd)),
      });
    }

    cursor.setTime(slotEnd);
  }

  return slots;
}

function formatSlotLabel(start, end) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = t => {
    const h = t.getHours();
    const m = t.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}${m ? ':' + String(m).padStart(2, '0') : ''}${ampm}`;
  };
  return `${days[start.getDay()]} ${months[start.getMonth()]} ${start.getDate()}, ${fmt(start)}–${fmt(end)}`;
}

// ─── Account Status ───────────────────────────────────────────────────────────

async function getAccountStatus() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) {
    return { success: true, mode: 'byok', tier: 'byok', usage: null, limit: null };
  }
  try {
    const token = await getGoogleToken(false);
    const userInfo = await getUserInfo(token);
    const statusRes = await fetch(`${BACKEND_URL}/status`, {
      headers: { 'x-google-token': token },
    });
    if (!statusRes.ok) return { success: true, mode: 'backend', tier: 'free', usage: 0, limit: 5, email: userInfo.email };
    const status = await statusRes.json();
    return { success: true, mode: 'backend', email: userInfo.email, ...status };
  } catch {
    return { success: true, mode: 'unauthenticated', tier: 'free', usage: 0, limit: 5 };
  }
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(prompt, callType) {
  const { apiKey: byokKey } = await chrome.storage.local.get('apiKey');

  if (byokKey) {
    return callClaudeDirectly(byokKey, prompt);
  } else {
    return callClaudeViaBackend(prompt, callType);
  }
}

async function callClaudeDirectly(apiKey, prompt) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${res.status}`);
  }
  return res.json();
}

async function callClaudeViaBackend(prompt, callType) {
  let token = await getGoogleToken(true);
  let res = await fetchBackend(token, prompt, callType);

  if (res.status === 401) {
    // Token was stale — remove it and get a fresh one
    await removeCachedToken(token);
    token = await getGoogleToken(true);
    res = await fetchBackend(token, prompt, callType);
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    throw new Error(data.error === 'usage_limit_exceeded'
      ? 'Free tier limit reached. Please upgrade or add your own API key in settings.'
      : 'Rate limit exceeded. Please try again later.');
  }
  if (!res.ok) {
    console.error('[MAA] Backend error', res.status, data);
    throw new Error(`Backend error: ${res.status} — ${data.error ?? 'unknown'}`);
  }
  return data;
}

function fetchBackend(token, prompt, callType) {
  return fetch(BACKEND_URL, {
    method: 'POST',
    headers: {
      'x-google-token': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt, type: callType }),
  });
}

// ─── Google Auth Helpers ──────────────────────────────────────────────────────

function getGoogleToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise(resolve => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function getUserInfo(token) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}
