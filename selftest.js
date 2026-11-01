// Self-test: exercises the REAL SillyTavern APIs on the user's installation (storage round trip, the configured
// models, the chat) and produces a shareable report that contains no chat text, no diary and no secrets.
import { ctx, getSnapshot } from './host.js';
import { callModel, collectSecrets } from './llm.js';
import { TASKS, getProfileForTask } from './settings.js';
import { EXTENSION_VERSION } from './version.js';
import { parseJsonLoose, redactSecrets, toBase64Utf8, truncate } from './util.js';

const REQUIRED_FUNCTIONS = ['generateRaw', 'setExtensionPrompt', 'saveSettingsDebounced', 'getRequestHeaders', 'callGenericPopup', 'addOneMessage', 'saveChat'];
const REQUIRED_VALUES = ['eventSource', 'event_types', 'extensionSettings', 'chat', 'characters', 'POPUP_TYPE', 'POPUP_RESULT'];
const TEST_FILE = 'inner-life-selftest.json';

export async function runSelfTest(settings, { fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    const out = [];
    const add = (ok, label, detail = '') => out.push({ ok, label, detail });
    const secrets = collectSecrets(settings);
    const safe = (e) => redactSecrets(String(e?.message || e), secrets);
    const c = ctx();

    // 1) SillyTavern API surface
    const missing = [
        ...REQUIRED_FUNCTIONS.filter(k => typeof c[k] !== 'function'),
        ...REQUIRED_VALUES.filter(k => c[k] == null),
    ];
    add(missing.length === 0, 'API SillyTavern', missing.length ? `не найдено: ${missing.join(', ')} (возможно, версия SillyTavern слишком старая)` : 'все нужные функции найдены');

    // 2) The open chat
    const snap = getSnapshot();
    add(!!snap, 'Открытый чат', snap ? `«${snap.charName}», сообщений: ${snap.messages.length}` : 'нет чата с одним персонажем');

    // 3) Storage round trip (the same files API the extension uses for diary and memory)
    try {
        const payload = { t: Date.now(), s: 'проверка ✓ 🌍' };
        const up = await fetchImpl('/api/files/upload', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name: TEST_FILE, data: toBase64Utf8(JSON.stringify(payload)) }) });
        if (!up.ok) throw new Error(`загрузка: HTTP ${up.status}`);
        const rd = await fetchImpl(`/user/files/${TEST_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        if (!rd.ok) throw new Error(`чтение: HTTP ${rd.status}`);
        const back = JSON.parse(await rd.text());
        if (back.s !== payload.s || back.t !== payload.t) throw new Error('прочитано не то, что записано');
        await fetchImpl('/api/files/delete', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ path: `user/files/${TEST_FILE}` }) }).catch(() => {});
        add(true, 'Хранилище данных', 'запись и чтение файла работают');
    } catch (e) {
        add(false, 'Хранилище данных', safe(e));
    }

    // 4) Every distinct model in use: can it answer in JSON? (this is what the extension needs from it)
    const byProfile = new Map();
    for (const task of TASKS) {
        const p = getProfileForTask(settings, task);
        if (!byProfile.has(p.id)) byProfile.set(p.id, { profile: p, tasks: [] });
        byProfile.get(p.id).tasks.push(task);
    }
    for (const { profile, tasks } of byProfile.values()) {
        const label = `Модель «${profile.name}» (${tasks.join(', ')})`;
        const t0 = Date.now();
        try {
            const { text } = await callModel({ ...profile, retries: 0 }, {
                system: 'You are a JSON-only API. Output exactly one JSON object and nothing else.',
                user: 'Return {"ok": true, "n": 3}',
                maxTokens: 60,
            });
            const obj = parseJsonLoose(text);
            if (obj && obj.ok === true) add(true, label, `отвечает JSON-ом, ${Date.now() - t0} мс`);
            else add(false, label, `ответила, но не JSON-ом: «${truncate(text.replace(/\s+/g, ' ').trim(), 80)}». Такой модели трудно вести heartbeat: выберите более послушную`);
        } catch (e) {
            add(false, label, safe(e));
        }
    }
    return out;
}

/** Plain-text report for sharing. Contains no chat text, diary, memories or secrets. */
export function buildReport({ results = [], diag = [], settings, log = [] }) {
    const mark = (ok) => ok === true ? '[OK]  ' : ok === false ? '[FAIL]' : '[--]  ';
    const lines = [`Inner Life ${EXTENSION_VERSION}: отчёт самопроверки`, ''];
    lines.push('Проверки:', ...results.map(r => `${mark(r.ok)} ${r.label}${r.detail ? `: ${r.detail}` : ''}`), '');
    lines.push('Состояние:', ...diag.map(r => `${mark(r.ok)} ${r.label}${r.detail ? `: ${r.detail}` : ''}`), '');
    const h = settings.heartbeat, i = settings.initiative;
    lines.push('Настройки:',
        `включено: ${settings.enabled}; активность: ${h.activity}; мин. сообщений: ${h.minNewMessages}; интервал: ${h.intervalMin} мин; пауза: ${h.debounceSec} с; инициатива: ${i.mode}`,
        `лимиты: вызовов/час ${settings.limits.maxCallsPerHour}, /сутки ${settings.limits.maxCallsPerDay}; платные вызовы разрешены: ${settings.limits.backgroundCallsEnabled}; использовано сегодня: ${settings.usage.dayCalls}`,
        ...settings.models.profiles.map(p => `профиль «${p.name}»: ${p.type}${p.model ? `, модель ${p.model}` : ''}`),
        `назначения: ${Object.entries(settings.models.assign).map(([k, v]) => `${k}→${settings.models.profiles.find(p => p.id === v)?.name || v}`).join(', ')}`, '');
    const errors = log.filter(l => l.ok === false).slice(-8);
    lines.push('Последние проблемы из журнала:', ...(errors.length ? errors.map(l => `${new Date(l.ts).toISOString()} ${l.kind}: ${l.summary}`) : ['нет']));
    const secrets = collectSecrets(settings);
    return redactSecrets(lines.join('\n'), secrets);
}
