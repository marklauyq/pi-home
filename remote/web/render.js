/**
 * render.js — Pure functions for text rendering and time formatting.
 * No browser dependencies, no side effects.
 */

/**
 * Escape HTML special characters.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render plain text or minimal markdown to safe HTML.
 * Supports: fenced code blocks (```), inline `code`, **bold**, [links], line breaks.
 * @param {string} text
 * @returns {string} safe HTML string
 */
export function renderMessage(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);

  // Fenced code blocks: ```lang\ncode\n```
  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return '<pre><code>' + code.trim() + '</code></pre>';
  });

  // Inline code: `code`
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text**
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Links: [text](url) — only emit href for safe URLs
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    const safe = /^\s*(https?:|mailto:)/.test(url) || url.startsWith('/') || url.startsWith('.');
    return safe
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${text}</a>`
      : text;
  });

  // Line breaks → <br> (but not inside <pre>)
  // Split by <pre> blocks to preserve them, add <br> to plain text parts
  escaped = escaped.split(/(<pre>[\s\S]*?<\/pre>)/g).map((part, i) => {
    if (i % 2 === 1) return part; // code block, leave as-is
    return part.replace(/\n/g, '<br>');
  }).join('');

  return escaped;
}

/**
 * Format a timestamp (ms since epoch) as "time ago".
 * @param {number} ms - milliseconds since epoch
 * @returns {string}
 */
export function timeAgo(ms) {
  if (!ms) return '';
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Group history sessions into Today / This week / Older.
 * @param {Array} sessions - [{updatedAt, ...}]
 * @returns {Array<{label: string, sessions: Array}>}
 */
export function groupHistory(sessions) {
  const now = Date.now();
  const dayMs = 86400000;
  const weekMs = 7 * dayMs;

  const groups = [
    { label: 'Today', sessions: [], ms: dayMs },
    { label: 'This week', sessions: [], ms: weekMs },
    { label: 'Older', sessions: [], ms: Infinity },
  ];

  for (const s of sessions) {
    const age = now - s.updatedAt;
    if (age < dayMs) groups[0].sessions.push(s);
    else if (age < weekMs) groups[1].sessions.push(s);
    else groups[2].sessions.push(s);
  }

  return groups.filter(g => g.sessions.length > 0);
}
