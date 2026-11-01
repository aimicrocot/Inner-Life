// Pure rules deciding whether the character may write first. Everything here is deterministic and free:
// the model is asked only after these gates pass, and the gates are checked again right before sending.
import { dayKey, isQuietHour } from './util.js';

export const MODE_LIMITS = { rare: { minGapMin: 240, maxPerDay: 2 }, moderate: { minGapMin: 90, maxPerDay: 5 } };

export function initiativeLimits(init) {
    if (init.mode === 'custom') return { minGapMin: init.customMinGapMin, maxPerDay: init.customMaxPerDay };
    return MODE_LIMITS[init.mode] || null;
}

/** Resets per-day counters when the day changed. Mutates and returns the state. */
export function rollInitiativeState(st, now) {
    const d = dayKey(now);
    if (st.day !== d) { st.day = d; st.sent = 0; st.idleChecks = 0; }
    return st;
}

/** Consecutive initiative messages at the end of the chat that the user has not answered. */
export function countTrailingUnanswered(messages) {
    let n = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.is_user) break;
        if (m.initiative) n++; else break;
    }
    return n;
}

/**
 * @returns {{ok: boolean, reason?: string}}
 * ctx = { init, st, now, messages, lastActivityAt, composing, generating }
 */
export function canReachOut({ init, st, now, messages, lastActivityAt, composing, generating }, { ignoreTiming = false } = {}) {
    const limits = initiativeLimits(init);
    if (!limits) return { ok: false, reason: 'initiative-off' };
    if (generating) return { ok: false, reason: 'generating' };
    if (composing) return { ok: false, reason: 'user-is-typing' };
    if (!messages.length) return { ok: false, reason: 'empty-chat' };
    rollInitiativeState(st, now);
    if (countTrailingUnanswered(messages) >= init.maxUnanswered) return { ok: false, reason: 'unanswered-limit' };
    if (ignoreTiming) return { ok: true };
    if (isQuietHour(now, init.quietStart, init.quietEnd)) return { ok: false, reason: 'quiet-hours' };
    if (st.sent >= limits.maxPerDay) return { ok: false, reason: 'daily-limit' };
    if (st.lastSentTs && now - st.lastSentTs < limits.minGapMin * 60000) return { ok: false, reason: 'too-soon-after-last' };
    if (!lastActivityAt) return { ok: false, reason: 'silence-unknown' };
    if (now - lastActivityAt < init.minSilenceMin * 60000) return { ok: false, reason: 'conversation-is-live' };
    return { ok: true };
}

export function idleCheckDue({ init, st, now }) {
    rollInitiativeState(st, now);
    if (st.idleChecks >= init.maxIdleChecksPerDay) return { ok: false, reason: 'idle-check-daily-cap' };
    if (st.lastIdleTs && now - st.lastIdleTs < init.idleCheckMin * 60000) return { ok: false, reason: 'idle-check-interval' };
    return { ok: true };
}

export function recordIdleCheck(st, now) { rollInitiativeState(st, now); st.idleChecks += 1; st.lastIdleTs = now; }
export function recordInitiativeSent(st, now) { rollInitiativeState(st, now); st.sent += 1; st.lastSentTs = now; }

export function describeSilence(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return `${min} minutes`;
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
    return `${Math.round(h / 24)} days`;
}

export function timeOfDay(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 23 ? 'evening' : 'night';
    return `${part} (${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local time)`;
}

/** Cleans a generated chat message: strips "Name:" prefixes, wrapping quotes and code fences. */
export function cleanInitiativeText(raw, charName = '') {
    let t = String(raw ?? '').trim().replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
    if (charName) t = t.replace(new RegExp(`^${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), '');
    t = t.replace(/^["«“]\s*([\s\S]*?)\s*["»”]$/, '$1').trim();
    return t.length > 1500 ? t.slice(0, 1500).trimEnd() + '…' : t;
}
