// content.js — Gmail content script
// Injects a toolbar button into Gmail reply/compose windows.
// User clicks the button to open the Meeting Assistant sidebar.

const TOOLBAR_BTN_ATTR = 'data-maa-btn';
const SIDEBAR_ID = 'maa-sidebar';

// ─── Gmail DOM Selectors ──────────────────────────────────────────────────────

const SELECTORS = {
  emailBody: 'div[data-message-id] div.a3s.aiL',
  subject: 'h2.hP',
  sender: 'span.gD',
  composeBody: 'div[contenteditable][aria-label*="Message Body"], div[contenteditable][g_editable="true"]',
  emailContainer: 'div[data-message-id]',
  // The bottom toolbar row in a compose/reply window (contains Send button)
  composeToolbar: 'div.aDh, div[data-tooltip="More send options"]',
  // The formatting toolbar
  formatToolbar: 'div[aria-label="Formatting options"]',
};

// ─── Observe compose/reply windows opening ───────────────────────────────────

let _debounceTimer = null;
const observer = new MutationObserver(() => {
  if (!isExtensionValid()) { observer.disconnect(); return; }
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(injectToolbarButtons, 300);
});

observer.observe(document.body, { childList: true, subtree: true });
setTimeout(injectToolbarButtons, 1500);

function injectToolbarButtons() {
  // Find all formatting toolbars in open compose/reply boxes
  document.querySelectorAll(SELECTORS.formatToolbar).forEach(toolbar => {
    if (toolbar.querySelector(`[${TOOLBAR_BTN_ATTR}]`)) return; // already injected

    const btn = document.createElement('button');
    btn.setAttribute(TOOLBAR_BTN_ATTR, '1');
    btn.title = 'Meeting Assistant — insert availability';
    btn.textContent = 'Avail';
    btn.style.cssText = 'background:none;border:1px solid #dadce0;border-radius:3px;cursor:pointer;font-size:11px;font-weight:500;padding:2px 6px;vertical-align:middle;color:#444746;opacity:0.85;';
    btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
    btn.addEventListener('mouseleave', () => btn.style.opacity = '0.7');
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openSidebarForCompose(toolbar);
    });

    toolbar.appendChild(btn);
    console.log('[MAA] toolbar button injected');
  });
}

// ─── Open sidebar ─────────────────────────────────────────────────────────────

function openSidebarForCompose(toolbar) {
  // Gather email context from the thread above the compose box
  const subject = document.querySelector(SELECTORS.subject)?.innerText?.trim() || '';
  const emailContainer = document.querySelector(SELECTORS.emailContainer);
  const senderEl = emailContainer?.querySelector(SELECTORS.sender);
  const from = senderEl?.getAttribute('email') || senderEl?.innerText?.trim() || '';
  const body = emailContainer?.querySelector(SELECTORS.emailBody)?.innerText?.trim() || '';

  // Remove any existing sidebar
  document.getElementById(SIDEBAR_ID)?.remove();

  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;
  sidebar.innerHTML = getSidebarHTML();

  // Insert just above the toolbar row (stays within the compose area, below the email body)
  const toolbarRow = toolbar.parentElement;
  toolbarRow.insertAdjacentElement('beforebegin', sidebar);

  initSidebar(sidebar, { subject, from, body });
}

// ─── Sidebar HTML & logic ─────────────────────────────────────────────────────

function getSidebarHTML() {
  return `
<div id="maa-panel">
  <div id="maa-header">
    <span id="maa-title">📅 Meeting Assistant</span>
    <button id="maa-close" title="Close">✕</button>
  </div>
  <div id="maa-body">
    <div id="maa-status"></div>
    <div id="maa-slots-section" style="display:none">
      <p id="maa-slots-label">Select times to propose:</p>
      <div id="maa-slots-list"></div>
      <button id="maa-draft-btn" disabled>Draft Reply</button>
    </div>
    <button id="maa-fetch-btn">Fetch My Availability</button>
    <div id="maa-reply-section" style="display:none">
      <p>Reply drafted:</p>
      <textarea id="maa-reply-text" rows="6" readonly></textarea>
      <button id="maa-insert-btn">Insert into Reply</button>
    </div>
    <div id="maa-upgrade-notice" style="display:none">
      <p>You've used all 5 free replies this month.</p>
      <a href="options.html" target="_blank">Upgrade or add your API key →</a>
    </div>
  </div>
</div>`;
}

function initSidebar(sidebar, emailContext) {
  let selectedSlots = [];

  sidebar.querySelector('#maa-close').addEventListener('click', () => {
    sidebar.remove();
  });

  const fetchBtn = sidebar.querySelector('#maa-fetch-btn');
  const slotsSection = sidebar.querySelector('#maa-slots-section');
  const slotsList = sidebar.querySelector('#maa-slots-list');
  const draftBtn = sidebar.querySelector('#maa-draft-btn');
  const replySection = sidebar.querySelector('#maa-reply-section');
  const replyText = sidebar.querySelector('#maa-reply-text');
  const insertBtn = sidebar.querySelector('#maa-insert-btn');
  const statusEl = sidebar.querySelector('#maa-status');
  const upgradeNotice = sidebar.querySelector('#maa-upgrade-notice');

  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    setStatus(statusEl, 'Fetching your calendar…', 'loading');

    try {
      const result = await sendMessage({ type: 'GET_CALENDAR_SLOTS' });
      if (!result?.success) throw new Error(result?.error || 'Failed to fetch slots');

      fetchBtn.style.display = 'none';
      slotsSection.style.display = 'block';
      setStatus(statusEl, '', '');

      slotsList.innerHTML = '';
      selectedSlots = [];

      result.slots.forEach((slot, i) => {
        const label = document.createElement('label');
        label.className = 'maa-slot';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = String(i);
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode('\u00a0' + slot.label));
        checkbox.addEventListener('change', e => {
          if (e.target.checked) {
            selectedSlots.push(slot.label);
          } else {
            selectedSlots = selectedSlots.filter(s => s !== slot.label);
          }
          draftBtn.disabled = selectedSlots.length === 0;
        });
        slotsList.appendChild(label);
      });
    } catch (err) {
      fetchBtn.disabled = false;
      setStatus(statusEl, `Error: ${err.message}`, 'error');
    }
  });

  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    setStatus(statusEl, 'Drafting reply…', 'loading');

    try {
      if (!isExtensionValid()) throw new Error('Extension context invalidated');
      const { userName } = await chrome.storage.sync.get('userName');
      const result = await sendMessage({
        type: 'DRAFT_REPLY',
        emailBody: emailContext.body,
        selectedSlots,
        userName: userName || '',
      });

      if (!result?.success) {
        if (result?.error?.includes('Free tier limit')) {
          upgradeNotice.style.display = 'block';
          setStatus(statusEl, '', '');
          return;
        }
        throw new Error(result?.error || 'Failed to draft reply');
      }

      setStatus(statusEl, '', '');
      replySection.style.display = 'block';
      replyText.value = result.replyText;
      draftBtn.disabled = false;
    } catch (err) {
      draftBtn.disabled = false;
      setStatus(statusEl, `Error: ${err.message}`, 'error');
    }
  });

  insertBtn.addEventListener('click', () => {
    const text = replyText.value;
    if (!text) return;
    insertReplyText(text);
    setStatus(statusEl, 'Reply inserted!', 'success');
    replySection.style.display = 'none';
  });
}

// ─── Reply Insertion ──────────────────────────────────────────────────────────

function insertReplyText(text) {
  const composeBox = document.querySelector(SELECTORS.composeBody);
  if (composeBox) {
    composeBox.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    return;
  }

  const replyBtn = document.querySelector('span[data-tooltip="Reply"], button[data-tooltip="Reply"]');
  if (replyBtn) {
    replyBtn.click();
    waitForElement(SELECTORS.composeBody, 3000).then(el => {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    });
  }
}

function waitForElement(selector, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error('Timed out waiting for element')); }, timeout);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExtensionValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = type ? `maa-status maa-status-${type}` : '';
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!isExtensionValid()) {
      reject(new Error('Extension context invalidated'));
      return;
    }
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
#maa-sidebar {
  margin: 8px 0;
  font-family: 'Google Sans', Roboto, sans-serif;
  font-size: 13px;
}
#maa-panel {
  border: 1px solid #dadce0;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  overflow: hidden;
  max-width: 480px;
}
#maa-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #f8f9fa;
  border-bottom: 1px solid #dadce0;
}
#maa-title { font-weight: 500; color: #202124; }
#maa-close {
  background: none;
  border: none;
  cursor: pointer;
  color: #5f6368;
  font-size: 14px;
  padding: 2px 4px;
}
#maa-body { padding: 12px 14px; }
#maa-fetch-btn, #maa-draft-btn, #maa-insert-btn {
  background: #1a73e8;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  margin-top: 8px;
}
#maa-fetch-btn:disabled, #maa-draft-btn:disabled { background: #dadce0; color: #80868b; cursor: default; }
#maa-insert-btn { background: #188038; }
.maa-slot { display: block; padding: 4px 0; cursor: pointer; }
.maa-slot input { margin-right: 8px; }
#maa-reply-text { width: 100%; box-sizing: border-box; border: 1px solid #dadce0; border-radius: 4px; padding: 8px; font-size: 12px; resize: vertical; margin-top: 6px; }
.maa-status-loading { color: #5f6368; }
.maa-status-error { color: #d93025; }
.maa-status-success { color: #188038; }
#maa-upgrade-notice { background: #fef7e0; border: 1px solid #f9ab00; border-radius: 4px; padding: 10px; margin-top: 8px; }
#maa-upgrade-notice a { color: #1a73e8; }
`;
document.head.appendChild(style);
