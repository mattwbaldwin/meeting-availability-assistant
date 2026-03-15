// popup.js — toolbar popup logic

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  try {
    const status = await sendMessage({ type: 'GET_ACCOUNT_STATUS' });
    $('status-loading').style.display = 'none';
    $('status-content').style.display = 'block';

    const emailEl = $('popup-email');
    const tierBadge = $('popup-tier-badge');
    const usageSection = $('popup-usage-section');

    if (status.mode === 'byok') {
      emailEl.textContent = 'Your own API key';
      tierBadge.textContent = 'BYOK';
      tierBadge.className = 'tier-badge tier-byok';
    } else if (status.mode === 'backend' && status.email) {
      emailEl.textContent = status.email;
      const isPaid = status.tier === 'paid';
      tierBadge.textContent = isPaid ? 'Paid' : 'Free';
      tierBadge.className = `tier-badge tier-${isPaid ? 'paid' : 'free'}`;
      if (!isPaid) {
        const used = status.usage ?? 0;
        const limit = status.limit ?? 5;
        usageSection.style.display = 'block';
        $('popup-usage-fill').style.width = `${Math.min(100, Math.round((used / limit) * 100))}%`;
        $('popup-usage-text').textContent = `${used} / ${limit} free replies used`;
      }
    } else {
      emailEl.textContent = 'Not signed in';
      tierBadge.textContent = 'Free';
      tierBadge.className = 'tier-badge tier-free';
    }
  } catch {
    $('status-loading').textContent = 'Sign in via Gmail to get started.';
  }
});

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}
