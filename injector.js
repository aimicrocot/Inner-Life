// Puts the character's memories into the main prompt right before every generation.
// Registered through manifest.json -> "generate_interceptor". Never calls a model: purely local retrieval.
import { PROMPT_ROLE, PROMPT_TYPE, ctx, getSnapshot } from './host.js';
import { buildInjection } from './prompts.js';
import { findReturnGap } from './time.js';
import { unsaidForInjection } from './unsaid.js';
import { goalsForInjection } from './goals.js';
import { getCharSettings } from './settings.js';
import { getCached, saveChar } from './storage.js';
import { markRecalled, retrieveMemories } from './store.js';

export const INJECTION_KEY = 'inner_life_continuity';
export const INTERCEPTOR_NAME = 'innerLifeInterceptor';

export function setInjection(text, settings) {
    const i = settings.injection;
    ctx().setExtensionPrompt(INJECTION_KEY, text, PROMPT_TYPE.IN_CHAT, i.depth, false, PROMPT_ROLE[i.role] ?? 0);
}

export function clearInjection() {
    ctx().setExtensionPrompt(INJECTION_KEY, '', PROMPT_TYPE.IN_CHAT, 0, false, 0);
}

/** Builds the text that would be injected now. Also used by the "preview" button. */
export function computeInjection(settings, { markUsed = false } = {}) {
    const snap = getSnapshot();
    if (!snap) return '';
    if (!settings.enabled || !settings.injection.enabled) return '';
    const cs = getCharSettings(settings, snap.avatar);
    if (!cs.enabled || !cs.inject) return '';
    const data = getCached(snap.avatar);
    if (!data) return '';
    const i = settings.injection;
    const query = snap.messages.slice(-3).map(m => m.mes).join('\n');
    const memories = cs.memory ? retrieveMemories(data, query, { limit: i.memoryLimit, maxChars: Math.floor(i.maxChars * 0.7) }) : [];
    const diaryEntry = cs.diary && i.includeDiary ? data.diary.at(-1) || null : null;
    const goals = cs.goals && i.includeGoals ? goalsForInjection(data, 3) : [];
    const unsaid = cs.unsaid && i.includeUnsaid ? unsaidForInjection(data, 2) : [];
    const ret = settings.awareness.timeGaps ? findReturnGap(snap.messages, settings.awareness.gapMinHours * 3600000) : null;
    const text = buildInjection({
        charName: snap.charName,
        userName: snap.userName,
        timeGap: ret ? { gapMs: ret.gapMs, now: Date.now() } : null,
        unsaid,
        mood: data.state.mood,
        workingNote: data.state.workingNote,
        goals,
        memories,
        diaryEntry,
        maxChars: i.maxChars,
        diaryChars: i.diaryChars,
    });
    if (text && markUsed && memories.length) {
        markRecalled(data, memories.map(m => m.id));
        saveChar(data);
    }
    return text;
}

export function installInterceptor(getSettings) {
    globalThis[INTERCEPTOR_NAME] = async function innerLifeInterceptor(_chat, _contextSize, _abort, type) {
        try {
            const settings = getSettings();
            if (type === 'quiet') { clearInjection(); return; } // other extensions' side prompts do not need our notes
            const text = computeInjection(settings, { markUsed: true });
            if (text) setInjection(text, settings); else clearInjection();
        } catch (e) {
            console.warn('[inner-life] interceptor failed', e);
        }
    };
}
