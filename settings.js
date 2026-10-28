// Settings schema, defaults and migration. Pure (no SillyTavern imports).
import { emptyUsage } from './budget.js';
import { clamp, uid } from './util.js';

export const SETTINGS_SCHEMA = 1;
export const CURRENT_PROFILE_ID = 'current';

export const DEFAULT_SETTINGS = {
    schema: SETTINGS_SCHEMA,
    enabled: false, // master switch: nothing runs until the user turns it on
    characters: {}, // avatar -> { enabled, diary, memory, inject }
    heartbeat: {
        intervalMin: 10, // minimum spacing between cycles for one character
        minNewMessages: 4, // deterministic gate: no model call below this
        debounceSec: 25, // wait for quiet after the last message
        maxContextMessages: 24,
        maxOutputTokens: 500,
        diaryMinGapMin: 30, // anti-spam: min gap between two diary entries
        paused: false,
    },
    limits: {
        backgroundCallsEnabled: true, // kill switch for all paid background calls
        maxCallsPerHour: 12,
        maxCallsPerDay: 80,
        maxOutputTokensPerDay: 60000,
    },
    usage: emptyUsage(),
    memory: {
        maxActive: 200,
        maxPerCycle: 6,
        similarityThreshold: 0.72,
    },
    goals: {
        maxActive: 5, // active long + step goals together
        maxNewPerDay: 3, // anti-loop: cap on newly created goals per day
        staleDays: 14, // untouched active goals become irrelevant
        visibility: 'full', // 'full' | 'summary' | 'hidden' (what the user sees in the panel)
    },
    awareness: {
        timeGaps: true, // notice long absences between messages (free: computed locally)
        gapMinHours: 6,
    },
    unsaid: {
        maxHeld: 5, // things the character holds back at the same time
        expireDays: 14, // held thoughts that never surfaced fade away
    },
    initiative: {
        mode: 'off', // 'off' | 'rare' | 'moderate' | 'custom'
        customMinGapMin: 120,
        customMaxPerDay: 3,
        minSilenceMin: 20, // never interrupt a live conversation
        quietStart: 23, // quiet hours (local); equal values disable them
        quietEnd: 8,
        idleCheckMin: 30, // how often the (cheap) "should I write first?" check may run
        maxIdleChecksPerDay: 6,
        maxUnanswered: 1, // stop after this many unanswered initiative messages
    },
    injection: {
        enabled: true,
        depth: 3,
        role: 'system',
        maxChars: 1800,
        memoryLimit: 8,
        includeDiary: true,
        diaryChars: 350,
        includeGoals: true,
        includeUnsaid: true,
    },
    privacy: {
        sendCharacterCard: true,
        cardChars: 900,
    },
    models: {
        profiles: [{ id: CURRENT_PROFILE_ID, name: 'Текущая модель SillyTavern', type: 'current', builtin: true }],
        assign: { heartbeat: CURRENT_PROFILE_ID, diary: CURRENT_PROFILE_ID, memory: CURRENT_PROFILE_ID, goals: CURRENT_PROFILE_ID, initiative: CURRENT_PROFILE_ID },
    },
};

export const TASKS = ['heartbeat', 'diary', 'memory', 'goals', 'initiative'];

export const DEFAULT_CHAR_SETTINGS = { enabled: false, diary: true, memory: true, goals: true, unsaid: true, initiative: false, inject: true };

export function newProfile(type = 'openai') {
    return {
        id: uid('prof'),
        name: type === 'st-profile' ? 'Профиль Connection Manager' : 'Мой эндпоинт',
        type, // 'current' | 'st-profile' | 'openai'
        stProfileId: '',
        baseUrl: '',
        apiKey: '',
        persistKey: true,
        model: '',
        temperature: 0.7,
        maxTokens: 600,
        timeoutSec: 60,
        retries: 1,
    };
}

function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o); }

function deepAssign(target, src) {
    for (const key of Object.keys(src)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (key === 'characters') {
            if (isPlain(src.characters)) {
                target.characters = {};
                for (const [k, v] of Object.entries(src.characters)) {
                    if (isPlain(v)) target.characters[k] = { ...DEFAULT_CHAR_SETTINGS, ...v };
                }
            }
            continue;
        }
        if (!(key in target)) continue;
        if (isPlain(target[key]) && isPlain(src[key])) deepAssign(target[key], src[key]);
        else if (typeof target[key] === typeof src[key] || target[key] === null) target[key] = src[key];
    }
}

export function sanitizeSettings(s) {
    const h = s.heartbeat;
    h.intervalMin = clamp(h.intervalMin, 1, 1440);
    h.minNewMessages = clamp(h.minNewMessages, 1, 200);
    h.debounceSec = clamp(h.debounceSec, 0, 600);
    h.maxContextMessages = clamp(h.maxContextMessages, 4, 100);
    h.maxOutputTokens = clamp(h.maxOutputTokens, 100, 4000);
    h.diaryMinGapMin = clamp(h.diaryMinGapMin, 0, 1440);
    const l = s.limits;
    l.maxCallsPerHour = clamp(l.maxCallsPerHour, 0, 10000);
    l.maxCallsPerDay = clamp(l.maxCallsPerDay, 0, 100000);
    l.maxOutputTokensPerDay = clamp(l.maxOutputTokensPerDay, 0, 100000000);
    const m = s.memory;
    m.maxActive = clamp(m.maxActive, 20, 5000);
    m.maxPerCycle = clamp(m.maxPerCycle, 1, 20);
    m.similarityThreshold = clamp(m.similarityThreshold, 0.3, 0.95);
    const i = s.injection;
    i.depth = clamp(i.depth, 0, 50);
    i.maxChars = clamp(i.maxChars, 200, 12000);
    i.memoryLimit = clamp(i.memoryLimit, 0, 40);
    i.diaryChars = clamp(i.diaryChars, 0, 2000);
    if (!['system', 'user', 'assistant'].includes(i.role)) i.role = 'system';
    s.privacy.cardChars = clamp(s.privacy.cardChars, 0, 6000);
    const g = s.goals;
    g.maxActive = clamp(g.maxActive, 1, 15);
    g.maxNewPerDay = clamp(g.maxNewPerDay, 0, 20);
    g.staleDays = clamp(g.staleDays, 1, 365);
    if (!['full', 'summary', 'hidden'].includes(g.visibility)) g.visibility = 'full';
    s.awareness.gapMinHours = clamp(s.awareness.gapMinHours, 1, 720);
    s.unsaid.maxHeld = Math.round(clamp(s.unsaid.maxHeld, 1, 20));
    s.unsaid.expireDays = clamp(s.unsaid.expireDays, 1, 365);
    const n = s.initiative;
    if (!['off', 'rare', 'moderate', 'custom'].includes(n.mode)) n.mode = 'off';
    n.customMinGapMin = clamp(n.customMinGapMin, 5, 10080);
    n.customMaxPerDay = clamp(n.customMaxPerDay, 1, 50);
    n.minSilenceMin = clamp(n.minSilenceMin, 1, 1440);
    n.quietStart = Math.round(clamp(n.quietStart, 0, 23));
    n.quietEnd = Math.round(clamp(n.quietEnd, 0, 23));
    n.idleCheckMin = clamp(n.idleCheckMin, 5, 1440);
    n.maxIdleChecksPerDay = clamp(n.maxIdleChecksPerDay, 1, 100);
    n.maxUnanswered = Math.round(clamp(n.maxUnanswered, 1, 5));
    return s;
}

/** Merges saved settings over defaults, repairs profiles/assignments. Always returns a complete object. */
export function mergeSettings(saved) {
    const base = structuredClone(DEFAULT_SETTINGS);
    if (isPlain(saved)) {
        deepAssign(base, saved);
        if (Array.isArray(saved?.models?.profiles)) {
            base.models.profiles = saved.models.profiles.filter(p => isPlain(p) && typeof p.id === 'string');
        }
    }
    if (!base.models.profiles.some(p => p.id === CURRENT_PROFILE_ID)) {
        base.models.profiles.unshift(structuredClone(DEFAULT_SETTINGS.models.profiles[0]));
    }
    for (const task of TASKS) {
        if (!base.models.profiles.some(p => p.id === base.models.assign[task])) base.models.assign[task] = CURRENT_PROFILE_ID;
    }
    base.schema = SETTINGS_SCHEMA;
    return sanitizeSettings(base);
}

export function getCharSettings(settings, avatar) {
    if (!settings.characters[avatar]) settings.characters[avatar] = { ...DEFAULT_CHAR_SETTINGS };
    return settings.characters[avatar];
}

export function getProfile(settings, id) {
    return settings.models.profiles.find(p => p.id === id) || settings.models.profiles.find(p => p.id === CURRENT_PROFILE_ID);
}

export function getProfileForTask(settings, task) {
    return getProfile(settings, settings.models.assign[task]);
}
