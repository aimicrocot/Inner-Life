// Pure helpers. No SillyTavern imports here, so this file is unit-testable in Node.

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** FNV-1a 32-bit hash, base36. */
export function hash32(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
}

/** File-name-safe key for a character (SillyTavern allows only [A-Za-z0-9_.-] in user files). */
export function safeFileKey(avatar) {
    const base = String(avatar || 'unknown').replace(/\.[a-z0-9]{2,5}$/i, '');
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'char';
    return `${slug}_${hash32(avatar)}`;
}

export function fileNameForCharacter(avatar) {
    return `inner-life-${safeFileKey(avatar)}.json`;
}

export function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.min(max, Math.max(min, x));
}

export function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 3.6);
}

export function truncate(text, max) {
    const s = String(text ?? '');
    return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

const STOP = new Set(('the and for are but not you your with that this was were have has had from they them their what when where which who whom will would '
    + 'can could should about into over just like then than too very also its it\'s i\'m dont don\'t '
    + 'это как так что чтобы был была были было его ее её они она оно они мне меня тебя тебе нас вас вам для при или если уже еще ещё там тут вот только очень '
    + 'можно нужно будет быть есть нет все всё его при про над под без'
).split(/\s+/));

export function tokenize(text) {
    const out = [];
    const matches = String(text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    for (const w of matches) {
        if (!STOP.has(w)) out.push(w);
    }
    return out;
}

export function jaccard(a, b) {
    const A = new Set(Array.isArray(a) ? a : tokenize(a));
    const B = new Set(Array.isArray(b) ? b : tokenize(b));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}

/**
 * Extracts JSON from model output: tolerates code fences, leading/trailing prose and trailing commas.
 * Returns null when nothing parseable is found.
 */
export function parseJsonLoose(text) {
    if (text == null) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const tryParse = (str) => {
        try { return JSON.parse(str); } catch { /* fallthrough */ }
        try { return JSON.parse(str.replace(/,\s*([}\]])/g, '$1')); } catch { return undefined; }
    };
    let r = tryParse(s);
    if (r !== undefined) return r;
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    const starts = [firstObj, firstArr].filter(i => i >= 0).sort((a, b) => a - b);
    for (const start of starts) {
        const open = s[start];
        const close = open === '{' ? '}' : ']';
        const end = s.lastIndexOf(close);
        if (end > start) {
            r = tryParse(s.slice(start, end + 1));
            if (r !== undefined) return r;
        }
    }
    return null;
}

/** Removes secrets from any string that may end up in logs or the UI. */
export function redactSecrets(text, secrets = []) {
    let s = String(text ?? '');
    for (const secret of secrets) {
        if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('***');
    }
    return s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***').replace(/(sk-[A-Za-z0-9_\-]{10,})/g, '***');
}

const pad = (n) => String(n).padStart(2, '0');
export function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function hourKey(ts) {
    const d = new Date(ts);
    return `${dayKey(ts)}T${pad(d.getHours())}`;
}

/** Quiet hours may wrap over midnight (e.g. 23 -> 7). start === end means "disabled". */
export function isQuietHour(ts, startHour, endHour) {
    const s = Number(startHour), e = Number(endHour);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
    const h = new Date(ts).getHours();
    return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

export function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

export function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${dayKey(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
