// options.js — settings page logic

const $ = id => document.getElementById(id);

async function loadSettings() {
  // API key is stored in local storage (not synced) to prevent cloud exposure.
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  const { userName = '' } = await chrome.storage.sync.get('userName');
  $('api-key').value = apiKey;
  $('user-name').value = userName;
}

async function loadAccountStatus() {
  try {
    const status = await sendMessage({ type: 'GET_ACCOUNT_STATUS' });
    $('account-loading').style.display = 'none';
    $('account-info').style.display = 'block';

    const tierBadge = $('tier-badge');
    const emailEl = $('account-email');
    const usageWrap = $('usage-wrap');
    const upgradeHint = $('upgrade-hint');

    if (status.mode === 'byok') {
      emailEl.textContent = 'Using your own API key';
      tierBadge.textContent = 'BYOK';
      tierBadge.className = 'tier-badge tier-byok';
    } else if (status.mode === 'backend') {
      emailEl.textContent = status.email || '';
      const isPaid = status.tier === 'paid';
      tierBadge.textContent = isPaid ? 'Paid' : 'Free';
      tierBadge.className = `tier-badge tier-${isPaid ? 'paid' : 'free'}`;
      $('sign-out-btn').style.display = 'inline-block';

      if (!isPaid) {
        const used = status.usage ?? 0;
        const limit = status.limit ?? 5;
        const pct = Math.min(100, Math.round((used / limit) * 100));
        usageWrap.style.display = 'block';
        $('usage-bar-fill').style.width = `${pct}%`;
        $('usage-label').textContent = `${used} of ${limit} free replies used this month`;

        if (used >= limit) {
          upgradeHint.textContent = "You've reached your free limit. Add your own API key above or upgrade to remove limits.";
          upgradeHint.style.display = 'block';
        }
      }
    } else {
      emailEl.textContent = 'Not signed in';
      tierBadge.textContent = 'Free';
      tierBadge.className = 'tier-badge tier-free';
    }
  } catch {
    $('account-loading').textContent = 'Could not load account info.';
  }
}

$('save-btn').addEventListener('click', async () => {
  const apiKey = $('api-key').value.trim();
  const userName = $('user-name').value.trim();
  // API key goes to local storage only; userName can sync across devices.
  await chrome.storage.local.set({ apiKey });
  await chrome.storage.sync.set({ userName });

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
