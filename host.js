// Thin adapter over SillyTavern's public context (SillyTavern.getContext()).
// Using the global context instead of relative imports keeps us independent of ST's internal file layout.

export const ctx = () => globalThis.SillyTavern.getContext();

// extension_prompt_types / extension_prompt_roles are stable numeric enums in SillyTavern.
export const PROMPT_TYPE = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const PROMPT_ROLE = { system: 0, user: 1, assistant: 2 };

export function toast(level, message, title = 'Inner Life') {
    const t = globalThis.toastr;
    if (t && typeof t[level] === 'function') t[level](message, title);
    else console.log(`[inner-life] ${level}: ${message}`);
}

// ---- main generation tracking (so background calls never compete with the user's reply) ----
let generatingSince = 0;
const STALE_MS = 180000;
export function markGenerating(on) { generatingSince = on ? Date.now() : 0; }
export function isGenerating() { return generatingSince > 0 && Date.now() - generatingSince < STALE_MS; }

function readCard(c, ch) {
    try {
        const f = c.getCharacterCardFields?.();
        if (f) return { description: f.description || '', personality: f.personality || '', scenario: f.scenario || '' };
    } catch { /* fall back to raw card fields */ }
    const d = ch?.data || {};
    return { description: d.description || ch?.description || '', personality: d.personality || ch?.personality || '', scenario: d.scenario || ch?.scenario || '' };
}

/**
 * Snapshot of the current single-character chat, or null (no chat / group chat / nothing selected).
 * Group chats are intentionally out of scope for this version.
 */
export function getSnapshot() {
    const c = ctx();
    if (c.groupId) return null;
    const ch = c.characters?.[c.characterId];
    if (!ch || !c.chatId || !Array.isArray(c.chat)) return null;
    const messages = [];
    let lastMessageAt = 0;
    c.chat.forEach((m, idx) => {
        if (!m || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) return;
        const ts = messageTime(c, m);
        messages.push({ idx, name: m.name || (m.is_user ? c.name1 : c.name2), is_user: !!m.is_user, mes: m.mes, initiative: !!m.extra?.inner_life?.initiative, ts });
        lastMessageAt = ts || lastMessageAt;
    });
    return {
        chatId: String(c.chatId),
        avatar: ch.avatar,
        charName: ch.name || c.name2,
        userName: c.name1 || 'User',
        card: readCard(c, ch),
        generating: isGenerating(),
        composing: isUserComposing(),
        lastMessageAt,
        messages,
    };
}

function messageTime(c, m) {
    try {
        const mo = c.timestampToMoment?.(m.send_date);
        if (mo && mo.isValid()) return mo.valueOf();
    } catch { /* fall through */ }
    const t = Date.parse(m.send_date);
    return Number.isFinite(t) ? t : 0;
}

/** True when the user has unsent text in the message box: we never write over someone who is typing. */
export function isUserComposing() {
    const el = globalThis.document?.getElementById('send_textarea');
    return !!(el && String(el.value || '').trim().length > 0);
}

/**
 * Adds a character message to the open chat the same way the /sendas command does
 * (push -> events -> render -> save), flagged so we can recognise our own initiative messages later.
 */
export async function insertCharacterMessage({ charName, text, reason = '' }) {
    const c = ctx();
    const now = Date.now();
    const send_date = new Date(now).toISOString();
    const extra = { api: 'manual', model: 'inner-life', gen_id: now };
    const message = {
        name: charName,
        is_user: false,
        is_system: false,
        send_date,
        mes: text,
        extra: { ...extra, inner_life: { initiative: true, reason: String(reason).slice(0, 200) } },
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ send_date, gen_started: null, gen_finished: null, extra }],
    };
    c.chat.push(message);
    const id = c.chat.length - 1;
    await c.eventSource.emit(c.event_types.MESSAGE_RECEIVED, id, 'extension');
    c.addOneMessage(message);
    await c.eventSource.emit(c.event_types.CHARACTER_MESSAGE_RENDERED, id, 'extension');
    await c.saveChat();
    return id;
}

export function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    const ch = c.characters?.[c.characterId];
    return ch ? { avatar: ch.avatar, name: ch.name, chatId: c.chatId ? String(c.chatId) : '' } : null;
}
