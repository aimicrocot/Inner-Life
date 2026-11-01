// Pure goal logic. The model proposes operations; this module validates and applies them with guard rails
// (limits, duplicate / loop protection, evidence for completion, respect for the user's manual changes).
import { dayKey, jaccard, clamp, tokenize, truncate, uid } from './util.js';

export const GOAL_KINDS = ['long', 'step'];
const MAX_OPS_PER_CYCLE = 3;
const MAX_LONG_ACTIVE = 3;
const MAX_STEPS_PER_PARENT = 3;
const CLOSED_MEMORY_DAYS = 14;

export const isOpen = (g) => g.status === 'active' || g.status === 'paused';

export function getActiveGoals(data) {
    return data.goals.filter(g => g.status === 'active');
}

export function getRecentlyClosed(data, now, days = CLOSED_MEMORY_DAYS) {
    return data.goals.filter(g => (g.status === 'done' || g.status === 'dropped') && now - (g.closedAt || g.updatedAt) <= days * 86400000);
}

function note(g, event, now, by = 'model', text = '') {
    g.history.push({ ts: now, event, by, note: truncate(text, 200) });
    g.updatedAt = now;
}

/** An open goal, or a recently closed one, that says (nearly) the same thing. Prevents re-creating and looping. */
export function findSimilarGoal(data, text, now, { threshold = 0.6 } = {}) {
    const t = tokenize(text);
    let best = null, bestSim = 0;
    for (const g of data.goals) {
        const relevant = isOpen(g) || (now - (g.closedAt || g.updatedAt)) <= CLOSED_MEMORY_DAYS * 86400000;
        if (!relevant) continue;
        const sim = jaccard(t, tokenize(g.text));
        if (sim > bestSim) { bestSim = sim; best = g; }
    }
    return bestSim >= threshold ? best : null;
}

export function createGoal(data, input, now, limits) {
    const text = String(input?.text ?? '').replace(/\s+/g, ' ').trim();
    const criteria = String(input?.criteria ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 8) return { action: 'skipped', reason: 'text-too-short' };
    if (criteria.length < 5) return { action: 'skipped', reason: 'no-completion-criteria' };
    const kind = GOAL_KINDS.includes(input.kind) ? input.kind : 'long';
    const by = input.by || 'model';
    const active = getActiveGoals(data);
    if (active.length >= limits.maxActive) return { action: 'skipped', reason: 'too-many-active-goals' };
    if (by === 'model' && limits.maxNewPerDay >= 0) {
        const today = dayKey(now);
        const createdToday = data.goals.filter(g => g.createdBy === 'model' && dayKey(g.createdAt) === today).length;
        if (createdToday >= limits.maxNewPerDay) return { action: 'skipped', reason: 'daily-goal-creation-limit' };
    }
    if (findSimilarGoal(data, text, now)) return { action: 'skipped', reason: 'duplicate-or-recently-closed' };
    let parentId = null;
    if (kind === 'step') {
        const parent = data.goals.find(g => g.id === input.parent && g.kind === 'long' && g.status === 'active');
        if (!parent) return { action: 'skipped', reason: 'step-without-active-parent' };
        if (active.filter(g => g.parentId === parent.id).length >= MAX_STEPS_PER_PARENT) return { action: 'skipped', reason: 'too-many-steps' };
        parentId = parent.id;
    } else if (active.filter(g => g.kind === 'long').length >= MAX_LONG_ACTIVE) {
        return { action: 'skipped', reason: 'too-many-long-goals' };
    }
    const goal = {
        id: uid('g'), createdAt: now, updatedAt: now, closedAt: 0,
        kind, parentId, text: truncate(text, 200),
        reason: truncate(String(input.reason ?? ''), 240), criteria: truncate(criteria, 240),
        priority: Math.round(clamp(input.priority ?? 3, 1, 5)),
        status: 'active', progress: '', evidence: [], locked: false,
        createdBy: by, chatId: input.chatId || limits.chatId || '', history: [],
    };
    note(goal, 'created', now, by, goal.reason);
    data.goals.push(goal);
    data.updatedAt = now;
    return { action: 'created', goal };
}

function close(data, g, status, now, by, text) {
    g.status = status;
    g.closedAt = now;
    note(g, status, now, by, text);
    if (g.kind === 'long') {
        for (const child of data.goals) {
            if (child.parentId === g.id && isOpen(child)) {
                child.status = 'dropped';
                child.closedAt = now;
                note(child, 'dropped', now, 'system', 'parent goal closed');
            }
        }
    }
}

/**
 * Applies model-proposed operations. Never throws; returns counters and the reasons for everything skipped.
 * The model cannot touch goals the user has edited/paused/dropped (`locked`).
 */
export function applyGoalOps(data, ops, now, limits) {
    const res = { created: 0, completed: 0, dropped: 0, updated: 0, paused: 0, resumed: 0, skipped: [] };
    if (!Array.isArray(ops)) return res;
    for (const op of ops.slice(0, MAX_OPS_PER_CYCLE)) {
        if (!op || typeof op !== 'object') continue;
        const kind = String(op.op || '').toLowerCase();
        if (kind === 'create') {
            const r = createGoal(data, { ...op, by: 'model' }, now, limits);
            if (r.action === 'created') res.created++; else res.skipped.push(r.reason);
            continue;
        }
        const g = data.goals.find(x => x.id === op.id);
        if (!g) { res.skipped.push('unknown-goal'); continue; }
        if (g.locked) { res.skipped.push('goal-locked-by-user'); continue; }
        if (kind === 'update') {
            if (!isOpen(g)) { res.skipped.push('goal-closed'); continue; }
            if (typeof op.progress === 'string' && op.progress.trim()) g.progress = truncate(op.progress.trim(), 240);
            if (op.priority != null) g.priority = Math.round(clamp(op.priority, 1, 5));
            if (typeof op.text === 'string' && op.text.trim().length >= 8 && !findSimilarGoalExcluding(data, op.text, now, g.id)) {
                g.history.push({ ts: now, event: 'text-changed', by: 'model', note: truncate(g.text, 200) });
                g.text = truncate(op.text.replace(/\s+/g, ' ').trim(), 200);
            }
            note(g, 'updated', now, 'model', g.progress);
            res.updated++;
        } else if (kind === 'complete') {
            if (!isOpen(g)) { res.skipped.push('goal-closed'); continue; }
            const ev = String(op.evidence ?? '').trim();
            if (ev.length < 5) { res.skipped.push('completion-without-evidence'); continue; }
            g.evidence.push({ ts: now, text: truncate(ev, 300) });
            close(data, g, 'done', now, 'model', ev);
            res.completed++;
        } else if (kind === 'drop') {
            if (!isOpen(g)) { res.skipped.push('goal-closed'); continue; }
            close(data, g, 'dropped', now, 'model', String(op.reason ?? ''));
            res.dropped++;
        } else if (kind === 'pause') {
            if (g.status !== 'active') { res.skipped.push('not-active'); continue; }
            g.status = 'paused'; note(g, 'paused', now, 'model', String(op.reason ?? '')); res.paused++;
        } else if (kind === 'resume') {
            if (g.status !== 'paused') { res.skipped.push('not-paused'); continue; }
            if (getActiveGoals(data).length >= limits.maxActive) { res.skipped.push('too-many-active-goals'); continue; }
            g.status = 'active'; note(g, 'resumed', now, 'model'); res.resumed++;
        } else {
            res.skipped.push('unknown-op');
        }
    }
    if (res.created + res.completed + res.dropped + res.updated + res.paused + res.resumed) data.updatedAt = now;
    return res;
}

function findSimilarGoalExcluding(data, text, now, excludeId) {
    const t = tokenize(text);
    return data.goals.some(g => g.id !== excludeId && isOpen(g) && jaccard(t, tokenize(g.text)) >= 0.6);
}

/** Active goals nobody touched for `staleDays` stop being relevant. Returns how many were dropped. */
export function expireStaleGoals(data, now, staleDays) {
    let n = 0;
    for (const g of data.goals) {
        if (g.status === 'active' && !g.locked && now - g.updatedAt > staleDays * 86400000) {
            close(data, g, 'dropped', now, 'system', `stale: no progress for ${staleDays} days`);
            n++;
        }
    }
    if (n) data.updatedAt = now;
    return n;
}

export function pruneClosedGoals(data, keep = 100) {
    const closed = data.goals.filter(g => !isOpen(g)).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    const drop = new Set(closed.slice(keep).map(g => g.id));
    if (drop.size) data.goals = data.goals.filter(g => !drop.has(g.id));
    return drop.size;
}

export function noteGoalProgress(data, id, text, now) {
    const g = data.goals.find(x => x.id === id && isOpen(x));
    if (!g) return false;
    note(g, 'progress', now, 'system', text);
    return true;
}

// ---------- user actions (always win; they lock the goal against model changes) ----------

export function userSetGoalStatus(data, id, status, now) {
    const g = data.goals.find(x => x.id === id);
    if (!g || !['active', 'paused', 'dropped'].includes(status)) return null;
    if (status === 'dropped') close(data, g, 'dropped', now, 'user', 'closed by user');
    else { g.status = status; g.closedAt = 0; note(g, status, now, 'user'); }
    g.locked = true;
    data.updatedAt = now;
    return g;
}

export function userEditGoal(data, id, text, now) {
    const g = data.goals.find(x => x.id === id);
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!g || t.length < 8) return null;
    g.history.push({ ts: now, event: 'text-changed', by: 'user', note: truncate(g.text, 200) });
    g.text = truncate(t, 200);
    g.locked = true;
    g.updatedAt = now;
    data.updatedAt = now;
    return g;
}

export function deleteGoal(data, id, now = Date.now()) {
    const i = data.goals.findIndex(x => x.id === id);
    if (i < 0) return false;
    data.goals.splice(i, 1);
    data.updatedAt = now;
    return true;
}

/** Top active goals for the main prompt: higher priority first, then most recently touched. */
export function goalsForInjection(data, limit = 3) {
    return getActiveGoals(data).sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt).slice(0, limit);
}
