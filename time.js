// Pure helpers for noticing absences. Messages carry `ts` (ms since epoch, 0 when unknown).

/**
 * The user has just come back after a long silence: the last user message is (almost) the newest one
 * and the message before it is older than the threshold. Returns {gapMs, at} or null.
 */
export function findReturnGap(messages, thresholdMs) {
    let u = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].is_user) { u = i; break; } }
    if (u < 1) return null;
    if (messages.length - 1 - u > 1) return null; // the conversation moved on: the return is old news
    const a = messages[u - 1].ts, b = messages[u].ts;
    if (!a || !b) return null;
    const gap = b - a;
    return gap >= thresholdMs ? { gapMs: gap, at: b } : null;
}

/** Long silences inside a transcript, so the diary can reflect on them. Largest first, at most `limit`. */
export function findGaps(messages, thresholdMs, limit = 2) {
    const out = [];
    for (let i = 1; i < messages.length; i++) {
        const a = messages[i - 1].ts, b = messages[i].ts;
        if (a && b && b - a >= thresholdMs) out.push({ index: i, gapMs: b - a, after: messages[i - 1], before: messages[i] });
    }
    return out.sort((x, y) => y.gapMs - x.gapMs).slice(0, limit);
}
