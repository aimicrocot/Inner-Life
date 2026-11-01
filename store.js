// Pure data logic for a character's diary + memory. No I/O, no SillyTavern imports.
import { clamp, jaccard, tokenize, truncate, uid } from './util.js';

export const DATA_SCHEMA = 1;
export const MEMORY_TYPES = ['episodic', 'semantic', 'autobiographical', 'working', 'emotional'];
export const CONFIDENCE = ['confirmed', 'inferred', 'uncertain'];
const CONF_RANK = { uncertain: 0, inferred: 1, confirmed: 2 };

export function emptyInitiativeState() {
    return { day: '', sent: 0, idleChecks: 0, lastSentTs: 0, lastIdleTs: 0 };
}

export function emptyCharData(avatar, name, now = Date.now()) {
    return {
        schema: DATA_SCHEMA,
        avatar,
        name,
        createdAt: now,
        updatedAt: now,
        diary: [],
        memories: [],
        goals: [],
        unsaid: [],
        state: { mood: '', workingNote: '', lastCycleTs: 0, lastDiaryTs: 0, processed: {}, log: [], initiative: emptyInitiativeState() },
    };
}

/** Repairs data loaded from disk. Never drops user content; fixes only structure. */
export function migrateCharData(raw, avatar, name, now = Date.now()) {
    const d = raw && typeof raw === 'object' ? raw : emptyCharData(avatar, name, now);
    d.schema = DATA_SCHEMA;
    d.avatar = d.avatar || avatar;
    d.name = name || d.name;
    if (!Array.isArray(d.diary)) d.diary = [];
    if (!Array.isArray(d.memories)) d.memories = [];
    if (!Array.isArray(d.goals)) d.goals = [];
    if (!Array.isArray(d.unsaid)) d.unsaid = [];
    if (!d.state || typeof d.state !== 'object') d.state = {};
    const st = d.state;
    st.mood = typeof st.mood === 'string' ? st.mood : '';
    st.workingNote = typeof st.workingNote === 'string' ? st.workingNote : '';
    st.lastCycleTs = Number(st.lastCycleTs) || 0;
    st.lastDiaryTs = Number(st.lastDiaryTs) || 0;
    if (!st.processed || typeof st.processed !== 'object') st.processed = {};
    if (!Array.isArray(st.log)) st.log = [];
    st.initiative = { ...emptyInitiativeState(), ...(st.initiative && typeof st.initiative === 'object' ? st.initiative : {}) };
    d.createdAt = d.createdAt || now;
    d.updatedAt = d.updatedAt || now;
    return d;
}

// ---------- diary ----------

export function addDiaryEntry(data, input, now = Date.now()) {
    const text = String(input?.text ?? '').trim();
    if (text.length < 10) return null;
    const entry = {
        id: uid('d'),
        ts: now,
        chatId: input.chatId || '',
        source: input.source || 'heartbeat',
        text: truncate(text, 4000),
        mood: truncate(String(input.mood || ''), 60),
        tags: Array.isArray(input.tags) ? input.tags.map(t => truncate(String(t), 24)).filter(Boolean).slice(0, 5) : [],
        edited: false,
        revisit: null, // { of: entryId, stance } when the character returns to an earlier entry
        revisedBy: [],
    };
    // Returning to an earlier thought never rewrites it: a NEW entry points back, the old one is only marked.
    const target = input.revisit?.of ? data.diary.find(e => e.id === input.revisit.of) : null;
    if (target) {
        entry.revisit = { of: target.id, stance: ['confirmed', 'revised', 'withdrawn'].includes(input.revisit.stance) ? input.revisit.stance : 'revised' };
        target.revisedBy = Array.isArray(target.revisedBy) ? target.revisedBy : [];
        target.revisedBy.push(entry.id);
    }
    data.diary.push(entry);
    data.state.lastDiaryTs = now;
    data.updatedAt = now;
    return entry;
}

export function updateDiaryEntry(data, id, text, now = Date.now()) {
    const e = data.diary.find(x => x.id === id);
    const t = String(text ?? '').trim();
    if (!e || t.length < 1) return null;
    e.text = truncate(t, 4000);
    e.edited = true;
    e.editedAt = now;
    data.updatedAt = now;
    return e;
}

export function deleteDiaryEntry(data, id, now = Date.now()) {
    const i = data.diary.findIndex(x => x.id === id);
    if (i < 0) return false;
    data.diary.splice(i, 1);
    data.updatedAt = now;
    return true;
}

export function searchDiary(data, { query = '', chatId = '', order = 'desc', from = 0, to = 0 } = {}) {
    const q = String(query).trim().toLowerCase();
    let list = data.diary.filter(e => {
        if (chatId && e.chatId !== chatId) return false;
        if (from && e.ts < from) return false;
        if (to && e.ts > to) return false;
        if (q && !(e.text.toLowerCase().includes(q) || (e.mood || '').toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q)))) return false;
        return true;
    });
    list = list.slice().sort((a, b) => order === 'asc' ? a.ts - b.ts : b.ts - a.ts);
    return list;
}

/** Older diary entries that relate to the given text (candidates for being revisited). Read-only. */
export function relevantDiary(data, text, { limit = 3, excludeIds = [], now = Date.now() } = {}) {
    const q = new Set(tokenize(text));
    if (!q.size) return [];
    const skip = new Set(excludeIds);
    const scored = [];
    for (const e of data.diary) {
        if (skip.has(e.id)) continue;
        const et = new Set(tokenize(`${e.text} ${e.tags.join(' ')}`));
        let inter = 0;
        for (const t of q) if (et.has(t)) inter++;
        if (!inter) continue;
        const ageDays = Math.max(0, (now - e.ts) / 86400000);
        scored.push({ e, score: inter / Math.min(q.size, 8) + 1 / (1 + ageDays / 30) * 0.3 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.e);
}

// ---------- memory ----------

function normalizeMemoryInput(input) {
    const text = String(input?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 5) return null;
    return {
        text: truncate(text, 400),
        type: MEMORY_TYPES.includes(input.type) ? input.type : 'episodic',
        confidence: CONFIDENCE.includes(input.confidence) ? input.confidence : 'inferred',
        importance: Math.round(clamp(input.importance ?? 3, 1, 5)),
        tags: Array.isArray(input.tags) ? input.tags.map(t => truncate(String(t), 24)).filter(Boolean).slice(0, 5) : [],
        chatId: input.chatId || '',
        from: input.from || 'heartbeat',
    };
}

/**
 * Adds a memory, or merges it into a near-duplicate. Returns {action, memory?, reason?}.
 * Merging never silently rewrites: the previous text goes into `history`.
 */
export function addMemory(data, input, now = Date.now(), { similarityThreshold = 0.72 } = {}) {
    const n = normalizeMemoryInput(input);
    if (!n) return { action: 'skipped', reason: 'invalid' };
    const qTokens = tokenize(n.text);
    let best = null, bestSim = 0;
    for (const m of data.memories) {
        if (m.status !== 'active') continue;
        const sim = jaccard(qTokens, tokenize(m.text));
        if (sim > bestSim) { bestSim = sim; best = m; }
    }
    if (best && bestSim >= similarityThreshold) {
        best.seen = (best.seen || 1) + 1;
        best.importance = Math.max(best.importance, n.importance);
        best.updatedAt = now;
        if (CONF_RANK[n.confidence] > CONF_RANK[best.confidence]) best.confidence = n.confidence;
        if (!best.userEdited && n.text.length > best.text.length * 1.2 && CONF_RANK[n.confidence] >= CONF_RANK[best.confidence]) {
            best.history.push({ ts: now, text: best.text, reason: 'merge-refinement' });
            best.text = n.text;
        }
        data.updatedAt = now;
        return { action: 'merged', memory: best };
    }
    const mem = {
        id: uid('m'),
        createdAt: now,
        updatedAt: now,
        type: n.type,
        text: n.text,
        confidence: n.confidence,
        importance: n.importance,
        tags: n.tags,
        source: { chatId: n.chatId, from: n.from },
        status: 'active',
        pinned: false,
        userEdited: false,
        seen: 1,
        recalls: 0,
        lastRecalled: 0,
        history: [],
    };
    data.memories.push(mem);
    data.updatedAt = now;
    return { action: 'added', memory: mem };
}

/** Controlled edit. Every text change is kept in history with its author and reason. */
export function updateMemory(data, id, patch, now = Date.now(), { by = 'user', reason = '' } = {}) {
    const m = data.memories.find(x => x.id === id);
    if (!m) return null;
    if (typeof patch.text === 'string') {
        const t = patch.text.replace(/\s+/g, ' ').trim();
        if (t.length >= 5 && t !== m.text) {
            m.history.push({ ts: now, text: m.text, reason: reason || `${by}-edit`, by });
            m.text = truncate(t, 400);
        }
    }
    if (MEMORY_TYPES.includes(patch.type)) m.type = patch.type;
    if (CONFIDENCE.includes(patch.confidence)) m.confidence = patch.confidence;
    if (patch.importance != null) m.importance = Math.round(clamp(patch.importance, 1, 5));
    if (Array.isArray(patch.tags)) m.tags = patch.tags.map(t => truncate(String(t), 24)).filter(Boolean).slice(0, 5);
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    if (patch.status === 'active' || patch.status === 'archived') m.status = patch.status;
    if (by === 'user') m.userEdited = true;
    m.updatedAt = now;
    data.updatedAt = now;
    return m;
}

export function deleteMemory(data, id, now = Date.now()) {
    const i = data.memories.findIndex(x => x.id === id);
    if (i < 0) return false;
    data.memories.splice(i, 1);
    data.updatedAt = now;
    return true;
}

function retentionScore(m, now) {
    const ageDays = Math.max(0, (now - (m.lastRecalled || m.updatedAt || now)) / 86400000);
    return m.importance * 2 + Math.log2(1 + (m.recalls || 0)) + Math.log2(m.seen || 1) - ageDays / 30;
}

function isProtected(m) {
    return m.pinned || m.userEdited || m.importance >= 4;
}

/** Archives (never deletes) the least valuable unprotected active memories above the limit. */
export function enforceMemoryLimit(data, maxActive, now = Date.now()) {
    const active = data.memories.filter(m => m.status === 'active');
    let excess = active.length - maxActive;
    if (excess <= 0) return 0;
    const candidates = active.filter(m => !isProtected(m)).sort((a, b) => retentionScore(a, now) - retentionScore(b, now));
    let archived = 0;
    for (const m of candidates) {
        if (excess <= 0) break;
        m.status = 'archived';
        m.history.push({ ts: now, text: m.text, reason: 'auto-archived', by: 'system' });
        archived++; excess--;
    }
    if (archived) data.updatedAt = now;
    return archived;
}

/** Relevance-ranked retrieval. Read-only; call markRecalled() separately for what was actually used. */
export function retrieveMemories(data, queryText, { limit = 8, maxChars = 1200, now = Date.now() } = {}) {
    const q = new Set(tokenize(queryText));
    const scored = [];
    for (const m of data.memories) {
        if (m.status !== 'active') continue;
        let overlap = 0;
        if (q.size) {
            const mt = new Set(tokenize(m.text + ' ' + m.tags.join(' ')));
            let inter = 0;
            for (const t of q) if (mt.has(t)) inter++;
            overlap = Math.min(1, inter / Math.min(q.size, 6));
        }
        const ageDays = Math.max(0, (now - (m.updatedAt || now)) / 86400000);
        const recency = 1 / (1 + ageDays / 14);
        const score = m.importance * 0.6 + overlap * 3 + recency * 0.8 + (m.pinned ? 1 : 0);
        scored.push({ m, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    let chars = 0;
    for (const { m } of scored) {
        if (out.length >= limit) break;
        if (chars + m.text.length > maxChars) continue;
        out.push(m);
        chars += m.text.length;
    }
    return out;
}

export function markRecalled(data, ids, now = Date.now()) {
    const set = new Set(ids);
    for (const m of data.memories) {
        if (set.has(m.id)) { m.recalls = (m.recalls || 0) + 1; m.lastRecalled = now; }
    }
}

// ---------- activity log (no private content, no secrets) ----------

export function pushLog(data, { kind, summary, ok = true }, now = Date.now(), max = 60) {
    data.state.log.push({ ts: now, kind, summary: truncate(String(summary || ''), 160), ok });
    if (data.state.log.length > max) data.state.log.splice(0, data.state.log.length - max);
}

export function stats(data) {
    const active = data.memories.filter(m => m.status === 'active').length;
    const goalsActive = data.goals.filter(g => g.status === 'active').length;
    const unsaidHeld = data.unsaid.filter(u => u.status === 'held').length;
    return { unsaidHeld, diary: data.diary.length, memoriesActive: active, memoriesArchived: data.memories.length - active, goalsActive, goalsTotal: data.goals.length };
}
