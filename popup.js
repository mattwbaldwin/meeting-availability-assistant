// popup.js — toolbar popup logic

const $ = id => document.getElementById(id);

function renderStatus(status) {
  $('status-loading').style.display = 'none';
  $('status-content').style.display = 'block';

  const emailEl = $('popup-email');
  const tierBadge = $('popup-tier-badge');
  const usageSection = $('popup-usage-section');
  const signInBtn = $('sign-in-btn');

  if (status.mode === 'byok') {
    emailEl.textContent = 'Your own API key';
    tierBadge.textContent = 'BYOK';
    tierBadge.className = 'tier-badge tier-byok';
    signInBtn.style.display = 'none';
  } else if (status.mode === 'backend' && status.email) {
    emailEl.textContent = status.email;
    const isPaid = status.tier === 'paid';
    tierBadge.textContent = isPaid ? 'Paid' : 'Free';
    tierBadge.className = `tier-badge tier-${isPaid ? 'paid' : 'free'}`;
    signInBtn.style.display = 'none';
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
    signInBtn.disabled = false;
    signInBtn.textContent = '🔑 Sign in with Google';
    signInBtn.style.display = 'flex';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('sign-in-btn').addEventListener('click', async () => {
    $('sign-in-btn').disabled = true;
    $('sign-in-btn').textContent = 'Signing in…';
    try {
      const status = await sendMessage({ type: 'SIGN_IN' });
      if (status?.error) throw new Error(status.error);
      renderStatus(status);
    } catch (err) {
      $('sign-in-btn').disabled = false;
      $('sign-in-btn').textContent = '🔑 Sign in with Google';
      $('status-loading').style.display = 'block';
      $('status-loading').textContent = `Sign-in failed: ${err.message}`;
    }
  });

  try {
    const status = await sendMessage({ type: 'GET_ACCOUNT_STATUS' });
    renderStatus(status);
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
