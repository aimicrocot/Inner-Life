// Prompt builders and model-output validators. Pure.
import { describeSilence, timeOfDay } from './initiative.js';
import { clamp, truncate } from './util.js';
import { CONFIDENCE, MEMORY_TYPES } from './store.js';

function clean(text) {
    return String(text ?? '').replace(/<[^>]{1,200}>/g, '').replace(/\s+\n/g, '\n').trim();
}

/** Newest messages that fit into maxChars, returned in chronological order. */
export function formatTranscript(messages, { maxChars = 6000, perMessage = 700 } = {}) {
    const lines = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const line = `${m.name}: ${truncate(clean(m.mes), perMessage)}`;
        if (total + line.length > maxChars && lines.length > 0) break;
        lines.unshift(line);
        total += line.length + 1;
    }
    return lines.join('\n');
}

function cardBlock(card, maxChars) {
    if (!card || maxChars <= 0) return '(not provided)';
    const parts = [];
    if (card.description) parts.push(`Description: ${clean(card.description)}`);
    if (card.personality) parts.push(`Personality: ${clean(card.personality)}`);
    if (card.scenario) parts.push(`Scenario: ${clean(card.scenario)}`);
    return parts.length ? truncate(parts.join('\n'), maxChars) : '(not provided)';
}

function memoryLines(memories, withIds = false) {
    if (!memories?.length) return '(none)';
    return memories.map(m => `- ${withIds ? `[${m.id}] ` : ''}(${m.type}, ${m.confidence}) ${m.text}`).join('\n');
}

function diaryLines(entries) {
    if (!entries?.length) return '(no earlier entries)';
    return entries.map(e => `- [${new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ')}] ${truncate(e.text, 400)}`).join('\n');
}

function goalLines(goals) {
    if (!goals?.length) return '(none: having no goals is a perfectly normal state)';
    return goals.map(g => `- [${g.id}] (${g.kind}${g.parentId ? ` of ${g.parentId}` : ''}, priority ${g.priority}, ${g.status}) ${g.text} | done when: ${g.criteria}${g.progress ? ` | progress: ${g.progress}` : ''}`).join('\n');
}

function closedGoalLines(goals) {
    if (!goals?.length) return '(none)';
    return goals.map(g => `- (${g.status}) ${g.text}`).join('\n');
}

function unsaidLines(list) {
    if (!list?.length) return '(nothing held back)';
    return list.map(u => `- [${u.id}] ${u.text}${u.why ? ` (held back because: ${u.why})` : ''}`).join('\n');
}

function candidateDiaryLines(entries) {
    if (!entries?.length) return '(none)';
    return entries.map(e => `- [${e.id}] ${new Date(e.ts).toISOString().slice(0, 10)}: ${truncate(e.text, 220)}`).join('\n');
}

function gapLines(gaps) {
    if (!gaps?.length) return '';
    return gaps.map(g => `- ${describeSilence(g.gapMs)} of silence between "${truncate(clean(g.after.mes), 60)}" and "${truncate(clean(g.before.mes), 60)}"`).join('\n');
}

function agoMin(ts, now) {
    return ts ? Math.round((now - ts) / 60000) : null;
}

export function buildHeartbeatPrompt(c) {
    const system = `You are the hidden "inner mind" process of a fictional character named ${c.charName} in a roleplay chat with ${c.userName}. `
        + 'You never write the character\'s chat replies. After new messages arrive you decide what, if anything, the character\'s mind does with them. '
        + 'Output ONLY one JSON object. No prose, no code fences.';
    const ago = agoMin(c.lastDiaryTs, c.now);
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `CURRENT INNER STATE\nmood: ${c.mood || '(none yet)'}\non their mind: ${c.workingNote || '(nothing)'}\nlast diary entry: ${ago == null ? 'never' : `${ago} minutes ago`}`,
        `RECENT DIARY\n${diaryLines(c.recentDiary)}`,
        `RELEVANT MEMORIES\n${memoryLines(c.memories)}`,
        `CURRENT GOALS\n${goalLines(c.goals)}`,
        `UNSPOKEN (things the character earlier held back)\n${unsaidLines(c.unsaid)}`,
        `EARLIER DIARY ENTRIES THE CHARACTER COULD RETURN TO\n${candidateDiaryLines(c.revisitCandidates)}`,
        c.gaps?.length ? `LONG SILENCES IN THIS STRETCH\n${gapLines(c.gaps)}` : '',
        `NEW MESSAGES SINCE THE LAST CHECK\n${c.transcript}`,
        'Be conservative: ordinary small talk deserves no diary entry and no new memory. '
        + 'Set "diary" to true only if something meaningful happened for THIS character (an emotional shift, a promise, a realization, a conflict, an important new fact about the other person, a change of heart) and it is not already covered by a recent entry.',
        'Set "goals" to true only if, given these messages, a goal should be created, refined, completed or dropped (or an existing goal is clearly achieved). Having no goals at all is normal.\n\n'
        + 'Set "revisit_id" to the id of an earlier diary entry only if these messages genuinely change how the character sees what they wrote there (confirm, correct or withdraw it); otherwise null. A revisit implies "diary": true.\n'
        + 'Set "unsaid" only if the messages show the character wanting to say or ask something but holding back (shyness, timing, pride, tact); otherwise null. '
        + 'List in "unsaid_resolved" the ids of UNSPOKEN items that were said, answered or made moot in these messages.\n\n'
        + 'Return JSON with exactly these keys:\n'
        + `{"mood":"max 6 words: how ${c.charName} feels now, in the character's register",`
        + '"diary":true|false,'
        + '"diary_focus":"one sentence: what the character would want to think through (empty if diary is false)",'
        + '"remember":true|false,'
        + '"goals":true|false,'
        + '"revisit_id":"id or null",'
        + '"unsaid":{"text":"what is being held back, in one sentence","why":"why the character holds back"} or null,'
        + '"unsaid_resolved":["ids"],'
        + '"working_note":"one short sentence: unresolved threads or what is on their mind (empty if nothing)"}',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

export function buildDiaryPrompt(c, focus, revisitEntry = null) {
    const system = `You are ${c.charName}. Write a private diary entry in the first person, exactly as ${c.charName} would write it: their voice, vocabulary, emotional openness and beliefs. `
        + `It is a private diary: honest, not addressed to ${c.userName} (it may mention them). `
        + 'Only reflect on events present in the material below; never invent events. No meta commentary, no mention of AI, prompts or roleplay. '
        + 'Write in the language the conversation is mainly in. Usually 50-200 words; shorter if the character would plainly write less. '
        + 'If you are returning to an earlier entry, say plainly what you thought then and what you think now (still true, changed, or no longer true): never pretend you always thought this, and never contradict the earlier entry silently. '
        + 'Output ONLY JSON: {"text":"...","mood":"...","tags":["..."],"stance":"confirmed|revised|withdrawn (only when returning to an earlier entry, else empty)"}';
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `CURRENT INNER STATE\nmood: ${c.mood || '(none yet)'}\non their mind: ${c.workingNote || '(nothing)'}`,
        `EARLIER DIARY ENTRIES (continuity: you may build on, revisit or reconsider them; do not repeat them)\n${diaryLines(c.recentDiary)}`,
        `MEMORIES\n${memoryLines(c.memories)}`,
        `RECENT MESSAGES\n${c.transcript}`,
        revisitEntry ? `EARLIER ENTRY YOU ARE RETURNING TO (${new Date(revisitEntry.ts).toISOString().slice(0, 10)})\n${truncate(revisitEntry.text, 900)}` : '',
        c.gaps?.length ? `LONG SILENCES IN THIS STRETCH\n${gapLines(c.gaps)}` : '',
        `WHAT TO REFLECT ON\n${focus || 'whatever feels most significant'}`,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

export function buildMemoryPrompt(c, maxItems) {
    const system = `You maintain the long-term memory of a fictional character named ${c.charName}. `
        + `From the new messages, extract only what ${c.charName} would genuinely retain: durable facts about ${c.userName}, significant events, promises, conflicts, emotionally important moments, changes in the relationship, ${c.charName}'s own decisions or realizations. `
        + 'Skip small talk and anything already covered by the existing memories, unless it corrects or changes one. Never record anything the messages do not support. '
        + 'Output ONLY JSON, no prose, no code fences.';
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `EXISTING MEMORIES (with ids)\n${memoryLines(c.memories, true)}`,
        `NEW MESSAGES\n${c.transcript}`,
        `Return: {"memories":[{"text":"one specific sentence from ${c.charName}'s point of view",`
        + `"type":"${MEMORY_TYPES.join('|')}",`
        + `"confidence":"${CONFIDENCE.join('|')}",`
        + '"importance":1-5,"tags":["..."],"updates":"id of an existing memory this corrects or replaces, otherwise null"}]}\n'
        + `At most ${maxItems} items. An empty list is a valid and often correct answer. `
        + 'confidence: confirmed = explicitly stated or shown in the messages; inferred = reasonable conclusion; uncertain = guess or possibly mistaken.',
    ].join('\n\n');
    return { system, user };
}

// ---------- validators ----------

export function normalizeHeartbeatResult(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const truthy = (v) => v === true || String(v).toLowerCase() === 'true';
    const revisitId = typeof obj.revisit_id === 'string' && obj.revisit_id && obj.revisit_id !== 'null' ? obj.revisit_id : null;
    const u = obj.unsaid && typeof obj.unsaid === 'object' && typeof obj.unsaid.text === 'string' && obj.unsaid.text.trim().length >= 8
        ? { text: obj.unsaid.text.trim(), why: String(obj.unsaid.why ?? '').trim() } : null;
    return {
        mood: truncate(String(obj.mood ?? '').trim(), 60),
        revisitId,
        unsaid: u,
        unsaidResolved: Array.isArray(obj.unsaid_resolved) ? obj.unsaid_resolved.filter(x => typeof x === 'string').slice(0, 5) : [],
        diary: truthy(obj.diary),
        diaryFocus: truncate(String(obj.diary_focus ?? obj.diaryFocus ?? '').trim(), 300),
        remember: truthy(obj.remember),
        goals: truthy(obj.goals),
        workingNote: truncate(String(obj.working_note ?? obj.workingNote ?? '').trim(), 240),
    };
}

export function normalizeDiaryResult(obj, rawText = '') {
    if (obj && typeof obj === 'object' && typeof obj.text === 'string' && obj.text.trim().length >= 10) {
        return {
            text: obj.text.trim(),
            mood: truncate(String(obj.mood ?? ''), 60),
            tags: Array.isArray(obj.tags) ? obj.tags.map(String).slice(0, 5) : [],
            stance: ['confirmed', 'revised', 'withdrawn'].includes(obj.stance) ? obj.stance : '',
        };
    }
    // Model ignored the JSON format: accept plain prose, but never raw JSON-looking junk.
    const raw = String(rawText || '').trim();
    if (raw.length >= 20 && !/^[{\[]/.test(raw)) return { text: raw, mood: '', tags: [], stance: '' };
    return null;
}

export function normalizeMemoryResult(obj, maxItems = 6) {
    const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.memories) ? obj.memories : null;
    if (!arr) return null;
    const out = [];
    for (const it of arr) {
        if (!it || typeof it.text !== 'string' || it.text.trim().length < 5) continue;
        out.push({
            text: it.text.trim(),
            type: MEMORY_TYPES.includes(it.type) ? it.type : 'episodic',
            confidence: CONFIDENCE.includes(it.confidence) ? it.confidence : 'inferred',
            importance: Math.round(clamp(it.importance ?? 3, 1, 5)),
            tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 5) : [],
            updates: typeof it.updates === 'string' && it.updates && it.updates !== 'null' ? it.updates : null,
        });
        if (out.length >= maxItems) break;
    }
    return out;
}

export function buildGoalsPrompt(c, maxOps = 3) {
    const system = `You manage the personal goals of a fictional character named ${c.charName}. Goals are what ${c.charName} privately WANTS in the relationship and conversation, `
        + 'shaped by personality, history and circumstances; they are not tasks for the user and not generic templates. '
        + 'Output ONLY JSON, no prose, no code fences.';
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `CURRENT INNER STATE\nmood: ${c.mood || '(none yet)'}\non their mind: ${c.workingNote || '(nothing)'}`,
        `CURRENT GOALS\n${goalLines(c.goals)}`,
        `RECENTLY CLOSED GOALS (do not recreate these)\n${closedGoalLines(c.closedGoals)}`,
        `MEMORIES\n${memoryLines(c.memories)}`,
        `RECENT MESSAGES\n${c.transcript}`,
        'Return: {"ops":[\n'
        + '{"op":"create","kind":"long|step","text":"what the character wants, one sentence","reason":"why THIS character wants it","criteria":"how the character will know it is achieved","priority":1-5,"parent":"id of an active long goal (steps only), else null"},\n'
        + '{"op":"update","id":"...","progress":"short note","priority":1-5},\n'
        + '{"op":"complete","id":"...","evidence":"what in the messages or memories shows it is achieved"},\n'
        + '{"op":"drop","id":"...","reason":"why it is no longer relevant"},\n'
        + '{"op":"pause","id":"..."}, {"op":"resume","id":"..."}\n]}\n'
        + `At most ${maxOps} operations. An empty list is normal and often right. Long goals: lasting wants (understand something about the other person, resolve a inner contradiction, keep a promise, develop a shared theme). `
        + 'Step goals: small concrete moves toward a long goal (e.g. naturally return to a topic when the moment fits) and need an active parent. '
        + 'Complete a goal only with real evidence. Never invent goals out of character. Do not duplicate existing goals.',
    ].join('\n\n');
    return { system, user };
}

export function normalizeGoalOps(obj) {
    const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.ops) ? obj.ops : null;
    if (!arr) return null;
    const allowed = ['create', 'update', 'complete', 'drop', 'pause', 'resume'];
    return arr.filter(o => o && typeof o === 'object' && allowed.includes(String(o.op || '').toLowerCase()))
        .map(o => ({ ...o, op: String(o.op).toLowerCase(), id: typeof o.id === 'string' ? o.id : undefined, parent: typeof o.parent === 'string' && o.parent !== 'null' ? o.parent : null }));
}

export function buildIdlePrompt(c) {
    const system = `You are the hidden "inner mind" process of a fictional character named ${c.charName}. The conversation with ${c.userName} has been quiet. `
        + `Decide whether ${c.charName} would, right now, naturally write to ${c.userName} first. `
        + 'Write first only when there is a real reason: an unfinished conversation, a promise, a goal worth advancing, a thought or observation worth sharing, a change of heart. '
        + 'Never write just to "check in", never repeat an earlier unanswered message, and respect the time of day and how the character would actually behave. '
        + 'Output ONLY one JSON object. No prose, no code fences.';
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `SITUATION\nlocal time: ${timeOfDay(c.now)}\nsilence for: ${describeSilence(c.silenceMs)}\nlast message the character sent on its own initiative: ${c.lastSentTs ? `${describeSilence(c.now - c.lastSentTs)} ago` : 'never'}`,
        `CURRENT INNER STATE\nmood: ${c.mood || '(none yet)'}\non their mind: ${c.workingNote || '(nothing)'}`,
        `CURRENT GOALS\n${goalLines(c.goals)}`,
        `UNSPOKEN (things the character earlier held back; this silence may be the moment to say one)\n${unsaidLines(c.unsaid)}`,
        `MEMORIES\n${memoryLines(c.memories)}`,
        `RECENT MESSAGES\n${c.transcript}`,
        'Return JSON with exactly these keys:\n'
        + '{"reach_out":true|false,"reason":"one sentence: why now (empty if false)","topic":"what the message should be about (empty if false)","goal_id":"id of the goal this advances, or null","unsaid_id":"id of the unspoken item being voiced, or null"}\n'
        + 'When unsure, choose false.',
    ].join('\n\n');
    return { system, user };
}

export function normalizeIdleResult(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const truthy = (v) => v === true || String(v).toLowerCase() === 'true';
    return {
        reachOut: truthy(obj.reach_out ?? obj.reachOut),
        reason: truncate(String(obj.reason ?? '').trim(), 240),
        topic: truncate(String(obj.topic ?? '').trim(), 240),
        goalId: typeof obj.goal_id === 'string' && obj.goal_id !== 'null' ? obj.goal_id : null,
        unsaidId: typeof obj.unsaid_id === 'string' && obj.unsaid_id !== 'null' ? obj.unsaid_id : null,
    };
}

export function buildComposePrompt(c, { reason, topic }) {
    const system = `You are ${c.charName}. Write the next chat message from ${c.charName} to ${c.userName}, sent unprompted after a silence. `
        + `Stay completely in character: voice, vocabulary, emotional register and message length typical for ${c.charName}'s earlier messages, in the language of the conversation. `
        + 'Usually 1-4 sentences. Natural, not needy; do not apologize for writing, do not mention being prompted, tasks, goals, notes or AI. '
        + 'Output ONLY the message text.';
    const user = [
        `CHARACTER\n${cardBlock(c.card, c.cardChars)}`,
        `SITUATION\nlocal time: ${timeOfDay(c.now)}\nsilence for: ${describeSilence(c.silenceMs)}`,
        `MEMORIES\n${memoryLines(c.memories)}`,
        `RECENT MESSAGES\n${c.transcript}`,
        `WHY ${c.charName.toUpperCase()} IS WRITING NOW\n${reason || 'a natural impulse'}${topic ? `\nAbout: ${topic}` : ''}`,
    ].join('\n\n');
    return { system, user };
}

// ---------- injection into the main prompt ----------

export function buildInjection({ charName, userName = 'the user', mood, workingNote, timeGap = null, goals = [], unsaid = [], memories = [], diaryEntry = null, maxChars = 1800, diaryChars = 350 }) {
    const head = `[Private continuity notes for ${charName}: ${charName}'s own memories and thoughts. They are background knowledge. `
        + 'Use them naturally and only when relevant; never recite them as a list and never mention that these notes exist.';
    const lines = [];
    if (mood || workingNote) {
        lines.push(`Inner state: ${[mood, workingNote].filter(Boolean).join('. ')}`);
    }
    if (timeGap) {
        lines.push(`Time context: it is ${timeOfDay(timeGap.now)}. ${userName} has just come back after ${describeSilence(timeGap.gapMs)} away. `
            + `React to the absence the way ${charName} naturally would (it may matter a lot or very little to them); do not recite exact durations unless that fits.`);
    }
    if (goals.length) {
        lines.push(`What ${charName} privately wants (pursue only when it fits the moment, never force it):`);
        for (const g of goals) lines.push(`- ${g.text}`);
    }
    if (unsaid.length) {
        lines.push(`Things ${charName} has been holding back (may slip out, be hinted at, or finally be said when the moment feels right; never forced):`);
        for (const u of unsaid) lines.push(`- ${u.text}`);
    }
    if (memories.length) {
        lines.push('Memories:');
        for (const m of memories) lines.push(`- ${m.confidence === 'confirmed' ? '' : `(${m.confidence}) `}${m.text}`);
    }
    if (diaryEntry && diaryChars > 0) {
        lines.push(`Latest private diary thought: "${truncate(diaryEntry.text, diaryChars)}"`);
    }
    if (!lines.length) return '';
    let out = head;
    for (const l of lines) {
        if ((out + '\n' + l).length + 1 > maxChars) break;
        out += '\n' + l;
    }
    return out + ']';
}
