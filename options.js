// options.js — settings page logic

const $ = id => document.getElementById(id);

async function loadSettings() {
  // API key is stored in local storage (not synced) to prevent cloud exposure.
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  const { userName = '', styleSample = '' } = await chrome.storage.sync.get(['userName', 'styleSample']);
  $('api-key').value = apiKey;
  $('user-name').value = userName;
  $('style-sample').value = styleSample;
}

async function loadAccountStatus() {
  try {
    const status = await sendMessage({ type: 'GET_ACCOUNT_STATUS' });
    $('account-loading').style.display = 'none';
    $('account-info').style.display = 'block';

    const tierBadge = $('tier-badge');
    const emailEl = $('account-email');
    const usageWrap = $('usage-wrap');

    if (status.mode === 'byok') {
      emailEl.textContent = 'Using your own API key';
      tierBadge.textContent = 'BYOK';
      tierBadge.className = 'tier-badge tier-byok';
    } else if (status.mode === 'backend') {
      emailEl.textContent = status.email || '';
      tierBadge.textContent = 'Free';
      tierBadge.className = 'tier-badge tier-free';
      $('sign-out-btn').style.display = 'inline-block';

      const used = status.usage ?? 0;
      const limit = status.limit ?? 5;
      const pct = Math.min(100, Math.round((used / limit) * 100));
      usageWrap.style.display = 'block';
      $('usage-bar-fill').style.width = `${pct}%`;
      $('usage-label').textContent = `${used} of ${limit} free replies used this month`;

      if (used >= limit) {
        const limitHint = $('limit-hint');
        limitHint.textContent = "You've reached your free limit. Add your own API key above for unlimited use.";
        limitHint.style.display = 'block';
      }

      // Show referral card for backend users
      $('referral-card').style.display = 'block';
      loadReferralInfo();
    } else {
      emailEl.textContent = 'Not signed in';
      tierBadge.textContent = 'Free';
      tierBadge.className = 'tier-badge tier-free';
    }
  } catch {
    $('account-loading').textContent = 'Could not load account info.';
  }
}


async function loadReferralInfo() {
  try {
    const info = await sendMessage({ type: 'GET_REFERRAL_INFO' });
    if (!info?.success) return;

    $('referral-code').value = info.code;

    if (info.referrals_made > 0) {
      $('referral-count-hint').textContent =
        `You've referred ${info.referrals_made} friend${info.referrals_made > 1 ? 's' : ''} — ${info.referrals_made * 5} bonus replies earned.`;
    }

    if (info.already_referred) {
      $('referral-input-wrap').style.display = 'none';
    }
  } catch { /* non-critical, stay silent */ }
}

$('copy-code-btn')?.addEventListener('click', () => {
  const code = $('referral-code').value;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $('copy-code-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
});

$('apply-referral-btn')?.addEventListener('click', async () => {
  const code = $('referral-input').value.trim().toUpperCase();
  const statusEl = $('referral-apply-status');
  const btn = $('apply-referral-btn');

  if (code.length !== 8) {
    statusEl.textContent = 'Enter the full 8-character code.';
    statusEl.style.color = '#dc2626';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Applying…';
  statusEl.textContent = '';

  const result = await sendMessage({ type: 'APPLY_REFERRAL', code });

  if (result?.success) {
    statusEl.textContent = `✓ Applied! You both get ${result.credits_added} extra replies every month.`;
    statusEl.style.color = '#188038';
    $('referral-input-wrap').style.display = 'none';
  } else {
    const msgs = {
      already_referred: "You've already used a referral code.",
      cannot_refer_self: "You can't use your own code.",
      code_not_found: 'Code not found — double-check and try again.',
    };
    statusEl.textContent = msgs[result?.error] || 'Something went wrong. Try again.';
    statusEl.style.color = '#dc2626';
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
});

$('save-btn').addEventListener('click', async () => {
  const apiKey = $('api-key').value.trim();
  const userName = $('user-name').value.trim();
  const styleSample = $('style-sample').value.trim().slice(0, 500);
  // API key goes to local storage only; userName and styleSample can sync across devices.
  await chrome.storage.local.set({ apiKey });
  await chrome.storage.sync.set({ userName, styleSample });

  const status = $('save-status');
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 2500);
});

$('sign-out-btn')?.addEventListener('click', () => {
  chrome.identity.clearAllCachedAuthTokens(() => {
    window.location.reload();
  });
});

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

loadSettings();
loadAccountStatus();
