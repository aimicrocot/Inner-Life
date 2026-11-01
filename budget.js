// Pure budget / rate-limit logic for background model calls.
import { dayKey, hourKey } from './util.js';

export function emptyUsage() {
    return { day: '', dayCalls: 0, dayInTokens: 0, dayOutTokens: 0, hour: '', hourCalls: 0 };
}

/** Resets hourly/daily buckets when the clock moved to a new hour/day. Mutates and returns usage. */
export function rollUsage(usage, now) {
    const d = dayKey(now), h = hourKey(now);
    if (usage.day !== d) { usage.day = d; usage.dayCalls = 0; usage.dayInTokens = 0; usage.dayOutTokens = 0; }
    if (usage.hour !== h) { usage.hour = h; usage.hourCalls = 0; }
    return usage;
}

/** @returns {{ok: boolean, reason?: string}} */
export function checkBudget(usage, limits, now) {
    rollUsage(usage, now);
    if (!limits.backgroundCallsEnabled) return { ok: false, reason: 'background-calls-disabled' };
    if (limits.maxCallsPerHour > 0 && usage.hourCalls >= limits.maxCallsPerHour) return { ok: false, reason: 'hourly-call-limit' };
    if (limits.maxCallsPerDay > 0 && usage.dayCalls >= limits.maxCallsPerDay) return { ok: false, reason: 'daily-call-limit' };
    if (limits.maxOutputTokensPerDay > 0 && usage.dayOutTokens >= limits.maxOutputTokensPerDay) return { ok: false, reason: 'daily-token-limit' };
    return { ok: true };
}

export function recordUsage(usage, now, inTokens = 0, outTokens = 0) {
    rollUsage(usage, now);
    usage.dayCalls += 1;
    usage.hourCalls += 1;
    usage.dayInTokens += Math.max(0, Math.round(inTokens));
    usage.dayOutTokens += Math.max(0, Math.round(outTokens));
    return usage;
}
