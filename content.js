// content.js — Gmail content script
// Injects a toolbar button into Gmail reply/compose windows.
// User clicks the button to open the Meeting Assistant panel.

const TOOLBAR_BTN_ATTR = 'data-maa-btn';
const SIDEBAR_ID = 'maa-sidebar';

// ─── Gmail DOM Selectors ──────────────────────────────────────────────────────

const SELECTORS = {
  emailBody: 'div[data-message-id] div.a3s.aiL',
  subject: 'h2.hP',
  sender: 'span.gD',
  composeBody: 'div[contenteditable][aria-label*="Message Body"], div[contenteditable][g_editable="true"]',
  emailContainer: 'div[data-message-id]',
  // Formatting toolbar (Bold/Italic row inside the compose window)
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
  document.querySelectorAll(SELECTORS.formatToolbar).forEach(bar => {
    if (bar.querySelector(`[${TOOLBAR_BTN_ATTR}]`)) return; // already injected

    // Only inject into the real formatting bar (has Bold/Italic), not the Send row
    const hasBold = bar.querySelector('[data-tooltip*="Bold"],[aria-label*="Bold"],[title*="Bold"]');
    if (!hasBold) return;

    const btn = document.createElement('button');
    btn.setAttribute(TOOLBAR_BTN_ATTR, '1');
    btn.title = 'Find a Time — insert availability';
    // Calendar SVG icon — sized to match Gmail's native icon buttons in the send row
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
    // Icon-only: fits in the row without wrapping, matches native Gmail icon button size
    btn.style.cssText = 'all:unset;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;cursor:pointer;box-sizing:border-box;vertical-align:middle;flex-shrink:0;';
    btn.addEventListener('mouseenter', () => btn.style.background = '#EEF2FF');
    btn.addEventListener('mouseleave', () => btn.style.background = '');
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openSidebarForCompose(bar, btn);
    });

    bar.appendChild(btn);
  });
}

// ─── Open sidebar ─────────────────────────────────────────────────────────────

function openSidebarForCompose(bar, btn) {
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

  document.body.appendChild(sidebar);
  positionSidebar(sidebar, btn);

  initSidebar(sidebar, { subject, from, body });
}

function positionSidebar(sidebar, anchorBtn) {
  const panelWidth = 300;
  const gap = 10;

  // Find the compose container to position relative to
  const compose = anchorBtn.closest('[role="dialog"]')
    || anchorBtn.closest('.nH.Hd')
    || anchorBtn.closest('.ip')
    || anchorBtn.closest('.AD')
    || anchorBtn.closest('table');
  const ref = compose ? compose.getBoundingClientRect() : anchorBtn.getBoundingClientRect();

  // Try right of compose, then left, then overlap right edge
  const margin = 16;
  let left;
  if (ref.right + gap + panelWidth < window.innerWidth - margin) {
    left = ref.right + gap;
  } else if (ref.left - gap - panelWidth > margin) {
    left = ref.left - gap - panelWidth;
  } else {
    left = window.innerWidth - panelWidth - margin;
  }

  // Align top with compose container, clamped to viewport
  const top = Math.max(8, ref.top);
  const maxHeight = window.innerHeight - top - 24;

  sidebar.style.cssText = `position:fixed;z-index:99999;top:${top}px;left:${left}px;width:${panelWidth}px;max-height:${maxHeight}px;overflow-y:auto;`;
}

// ─── Sidebar HTML & logic ─────────────────────────────────────────────────────

function getSidebarHTML() {
  return `
<div id="maa-panel">
  <div id="maa-header">
    <span id="maa-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Find a Time</span>
    <button id="maa-close" title="Close">&#x2715;</button>
  </div>
  <div id="maa-body">
    <div id="maa-upgrade-notice" style="display:none">
      <p>You've used all your free replies this month.</p>
      <a href="options.html" target="_blank" rel="noopener noreferrer">Add your own API key for unlimited use →</a>
    </div>
    <div id="maa-status" class="maa-status-loading">Loading your calendar…</div>
    <div id="maa-slots-section" style="display:none">
      <p id="maa-slots-label">Select times to propose:</p>
      <div id="maa-slots-list"></div>
      <button id="maa-draft-btn" disabled>Draft &amp; Insert Reply</button>
    </div>
  </div>
</div>`;
}

function renderSlots(slots, container, selectedSlots, draftBtn) {
  const byDay = {};
  const dayOrder = [];
  slots.forEach(slot => {
    const day = slot.label.split(',')[0];
    if (!byDay[day]) { byDay[day] = []; dayOrder.push(day); }
    byDay[day].push(slot);
  });
  dayOrder.forEach(day => {
    const dayHeader = document.createElement('div');
    dayHeader.className = 'maa-day-header';
    dayHeader.textContent = day;
    container.appendChild(dayHeader);

    const chipRow = document.createElement('div');
    chipRow.className = 'maa-chip-row';
    byDay[day].forEach(slot => {
      const chip = document.createElement('button');
      chip.className = 'maa-chip';
      chip.type = 'button';
      chip.textContent = slot.label.split(', ')[1] || slot.label;
      chip.addEventListener('click', () => {
        const selected = chip.classList.toggle('maa-chip-on');
        if (selected) {
          selectedSlots.push(slot.label);
        } else {
          const idx = selectedSlots.indexOf(slot.label);
          if (idx !== -1) selectedSlots.splice(idx, 1);
        }
        draftBtn.disabled = selectedSlots.length === 0;
      });
      chipRow.appendChild(chip);
    });
    container.appendChild(chipRow);
  });
}

function initSidebar(sidebar, emailContext) {
  let selectedSlots = [];

  sidebar.querySelector('#maa-close').addEventListener('click', () => sidebar.remove());

  // Make panel draggable by its header
  const header = sidebar.querySelector('#maa-header');
  let dragging = false, dragX = 0, dragY = 0;
  header.style.cursor = 'grab';
  header.addEventListener('mousedown', e => {
    if (e.target.id === 'maa-close') return;
    dragging = true;
    dragX = e.clientX - sidebar.getBoundingClientRect().left;
    dragY = e.clientY - sidebar.getBoundingClientRect().top;
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    sidebar.style.left = (e.clientX - dragX) + 'px';
    sidebar.style.top = (e.clientY - dragY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; header.style.cursor = 'grab'; }
  });

  const slotsSection = sidebar.querySelector('#maa-slots-section');
  const slotsList = sidebar.querySelector('#maa-slots-list');
  const draftBtn = sidebar.querySelector('#maa-draft-btn');
  const statusEl = sidebar.querySelector('#maa-status');
  const upgradeNotice = sidebar.querySelector('#maa-upgrade-notice');

  // ── Auto-fetch availability on open ────────────────────────────────────────
  (async () => {
    try {
      const result = await sendMessage({ type: 'GET_CALENDAR_SLOTS' });
      if (!result?.success) throw new Error(result?.error || 'Failed to fetch slots');

      setStatus(statusEl, '', '');
      slotsSection.style.display = 'block';
      slotsList.innerHTML = '';
      selectedSlots = [];

      const initialSlots = result.slots.slice(0, 9);
      const moreSlots = result.slots.slice(9);

      renderSlots(initialSlots, slotsList, selectedSlots, draftBtn);

      if (moreSlots.length > 0) {
        const showMoreBtn = document.createElement('button');
        showMoreBtn.id = 'maa-show-more-btn';
        showMoreBtn.textContent = `Show ${moreSlots.length} more times`;
        showMoreBtn.addEventListener('click', () => {
          showMoreBtn.remove();
          renderSlots(moreSlots, slotsList, selectedSlots, draftBtn);
        });
        slotsList.appendChild(showMoreBtn);
      }
    } catch (err) {
      setStatus(statusEl, `Could not load calendar: ${err.message}`, 'error');
    }
  })();

  // ── Draft & insert directly ────────────────────────────────────────────────
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
          slotsSection.style.display = 'none';
          upgradeNotice.style.display = 'block';
          setStatus(statusEl, '', '');
          return;
        }
        throw new Error(result?.error || 'Failed to draft reply');
      }

      insertReplyText(result.replyText);
      sidebar.remove();
      showFeedbackToast();
    } catch (err) {
      draftBtn.disabled = false;
      setStatus(statusEl, `Error: ${err.message}`, 'error');
    }
  });
}

// ─── Feedback Toast ───────────────────────────────────────────────────────────

function showFeedbackToast() {
  document.getElementById('maa-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'maa-toast';
  toast.innerHTML = `
    <span id="maa-toast-msg" style="color:#374151;font-size:12px;">Was this reply helpful?</span>
    <button id="maa-thumb-up" style="all:unset;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;" title="Yes">👍</button>
    <button id="maa-thumb-down" style="all:unset;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;" title="No">👎</button>
  `;
  toast.style.cssText = [
    'position:fixed',
    'z-index:99999',
    'bottom:80px',
    'right:24px',
    'background:#fff',
    'border:1px solid #e0e0e0',
    'border-top:3px solid #4F46E5',
    'border-radius:10px',
    'box-shadow:0 4px 16px rgba(79,70,229,0.12),0 1px 4px rgba(0,0,0,0.08)',
    'padding:10px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:"Google Sans",Roboto,Arial,sans-serif',
    'transition:opacity 0.3s',
  ].join(';');

  document.body.appendChild(toast);

  const dismiss = () => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  };
  let timer = setTimeout(dismiss, 10000);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 3000); });

  const handleRating = (rating) => {
    clearTimeout(timer);
    sendMessage({ type: 'SUBMIT_FEEDBACK', rating }).catch(() => {});
    const msg = toast.querySelector('#maa-toast-msg');
    const up = toast.querySelector('#maa-thumb-up');
    const down = toast.querySelector('#maa-thumb-down');
    msg.textContent = rating === 1 ? 'Thanks! 🎉' : "Got it — we'll improve!";
    up.style.display = 'none';
    down.style.display = 'none';
    setTimeout(dismiss, 1500);
  };

  toast.querySelector('#maa-thumb-up').addEventListener('click', () => handleRating(1));
  toast.querySelector('#maa-thumb-down').addEventListener('click', () => handleRating(-1));
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
  el.className = type ? `maa-status-${type}` : '';
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
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  font-size: 13px;
}
#maa-panel {
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 4px 24px rgba(79,70,229,0.10), 0 1px 6px rgba(0,0,0,0.08);
  border-top: 3px solid #4F46E5;
}
#maa-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  background: #fff;
  border-bottom: 1px solid #f3f4f6;
}
#maa-title {
  font-weight: 600;
  color: #111827;
  font-size: 13px;
  letter-spacing: -0.1px;
  display: flex;
  align-items: center;
  gap: 6px;
}
#maa-close {
  background: none;
  border: none;
  cursor: pointer;
  color: #9ca3af;
  font-size: 16px;
  padding: 2px 5px;
  border-radius: 5px;
  line-height: 1;
  transition: background 0.15s;
}
#maa-close:hover { background: #f3f4f6; color: #374151; }
#maa-body { padding: 10px 14px 14px; }
#maa-status { font-size: 12px; min-height: 18px; margin-bottom: 4px; color: #6b7280; }
.maa-status-error { color: #dc2626; font-weight: 500; }
#maa-slots-label {
  font-size: 10px;
  font-weight: 600;
  color: #9ca3af;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
#maa-slots-list { max-height: 210px; overflow-y: auto; margin-bottom: 6px; }
.maa-day-header {
  font-size: 11px;
  font-weight: 600;
  color: #374151;
  padding: 10px 0 5px;
  border-top: 1px solid #f3f4f6;
  margin-top: 2px;
}
.maa-day-header:first-child { border-top: none; padding-top: 0; }
.maa-chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
.maa-chip {
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  font-size: 12px;
  font-weight: 500;
  color: #374151;
  background: #f9fafb;
  border: 1.5px solid #e5e7eb;
  border-radius: 20px;
  padding: 4px 11px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.maa-chip:hover { border-color: #a5b4fc; background: #f5f3ff; color: #4338ca; }
.maa-chip-on { background: #EEF2FF; border-color: #4F46E5; color: #4338CA; font-weight: 600; }
#maa-show-more-btn {
  all: unset;
  display: block;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  font-size: 12px;
  color: #4F46E5;
  cursor: pointer;
  padding: 6px 0 2px;
  opacity: 0.8;
}
#maa-show-more-btn:hover { opacity: 1; text-decoration: underline; }
#maa-draft-btn {
  background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  cursor: pointer;
  width: 100%;
  margin-top: 4px;
  letter-spacing: 0.1px;
  transition: opacity 0.15s;
  position: sticky;
  bottom: 0;
}
#maa-draft-btn:hover:not(:disabled) { opacity: 0.9; }
#maa-draft-btn:disabled { background: #e5e7eb; color: #9ca3af; cursor: default; }
#maa-upgrade-notice {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: #92400e;
  line-height: 1.5;
}
#maa-upgrade-notice a { color: #4F46E5; font-weight: 500; }
`;
document.head.appendChild(style);
