// "Unsaid": things the character wanted to say or ask but held back (shyness, timing, pride, tact).
// They may surface later (in the main reply via soft prompt hints, or as an initiative message) or fade away.
import { jaccard, tokenize, truncate, uid } from './util.js';

const RECENT_MS = 14 * 86400000;

export const heldUnsaid = (data) => data.unsaid.filter(u => u.status === 'held');

export function addUnsaid(data, input, now, { maxHeld = 5, chatId = '' } = {}) {
    const text = String(input?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 8) return { action: 'skipped', reason: 'text-too-short' };
    const t = tokenize(text);
    for (const u of data.unsaid) {
        const relevant = u.status === 'held' || now - (u.resolvedAt || u.updatedAt) <= RECENT_MS;
        if (relevant && jaccard(t, tokenize(u.text)) >= 0.6) return { action: 'skipped', reason: 'duplicate-or-recently-resolved' };
    }
    if (heldUnsaid(data).length >= maxHeld) return { action: 'skipped', reason: 'too-many-held' };
    const item = {
        id: uid('u'), createdAt: now, updatedAt: now, resolvedAt: 0,
        text: truncate(text, 240), why: truncate(String(input.why ?? '').trim(), 200),
        status: 'held', chatId: input.chatId || chatId, note: '',
    };
    data.unsaid.push(item);
    data.updatedAt = now;
    return { action: 'added', item };
}

/** status: 'voiced' (it was said) | 'dropped' (no longer relevant / removed by the user). */
export function resolveUnsaid(data, ids, now, status = 'voiced', note = '') {
    let n = 0;
    const set = new Set(ids || []);
    for (const u of data.unsaid) {
        if (set.has(u.id) && u.status === 'held') {
            u.status = status; u.resolvedAt = now; u.updatedAt = now; u.note = truncate(note, 160);
            n++;
        }
    }
    if (n) data.updatedAt = now;
    return n;
}

export function expireUnsaid(data, now, expireDays) {
    let n = 0;
    for (const u of data.unsaid) {
        if (u.status === 'held' && now - u.updatedAt > expireDays * 86400000) {
            u.status = 'dropped'; u.resolvedAt = now; u.updatedAt = now; u.note = 'faded: never surfaced';
            n++;
        }
    }
    if (n) data.updatedAt = now;
    return n;
}

export function pruneUnsaid(data, keep = 60) {
    const closed = data.unsaid.filter(u => u.status !== 'held').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    const drop = new Set(closed.slice(keep).map(u => u.id));
    if (drop.size) data.unsaid = data.unsaid.filter(u => !drop.has(u.id));
    return drop.size;
}

export function deleteUnsaid(data, id, now = Date.now()) {
    const i = data.unsaid.findIndex(u => u.id === id);
    if (i < 0) return false;
    data.unsaid.splice(i, 1);
    data.updatedAt = now;
    return true;
}

/** Top held thoughts for the main prompt: the most recent first. */
export function unsaidForInjection(data, limit = 2) {
    return heldUnsaid(data).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
