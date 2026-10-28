// The extension's panel (opens in a SillyTavern popup). Plain DOM, no dependencies.
// All dynamic text goes through textContent / text nodes, so model output can never inject HTML.
import { ctx, toast } from './host.js';
import { collectSecrets, getKey, hasKey, setSessionKey, testProfile } from './llm.js';
import { deleteGoal, getActiveGoals, userEditGoal, userSetGoalStatus } from './goals.js';
import { CURRENT_PROFILE_ID, getCharSettings, newProfile, sanitizeSettings } from './settings.js';
import { deleteUnsaid, heldUnsaid, resolveUnsaid } from './unsaid.js';
import { CONFIDENCE, MEMORY_TYPES, addMemory, deleteDiaryEntry, deleteMemory, searchDiary, stats, updateDiaryEntry, updateMemory } from './store.js';
import { dayKey, fileNameForCharacter, formatDateTime } from './util.js';

const TYPE_RU = { episodic: 'эпизод', semantic: 'факт', autobiographical: 'о себе', working: 'текущее', emotional: 'эмоция' };
const CONF_RU = { confirmed: 'подтверждено', inferred: 'предположение', uncertain: 'неуверенно' };
const TASK_RU = { heartbeat: 'Heartbeat (решения «что делать»)', diary: 'Дневник', memory: 'Память', goals: 'Цели', initiative: 'Сообщения от персонажа первым (текст)' };
const GOAL_STATUS_RU = { active: 'активна', paused: 'на паузе', done: 'достигнута', dropped: 'отменена' };
const GOAL_KIND_RU = { long: 'долгосрочная', step: 'шаг' };
const STANCE_RU = { confirmed: 'подтверждает', revised: 'пересматривает', withdrawn: 'отказывается от прежнего вывода' };
const UNSAID_RU = { held: 'держит в себе', voiced: 'высказано', dropped: 'забыто/убрано' };
const INITIATIVE_RU = {
    'initiative-off': 'инициатива выключена', generating: 'идёт основная генерация', 'user-is-typing': 'вы набираете сообщение',
    'empty-chat': 'чат пуст', 'unanswered-limit': 'предыдущее сообщение осталось без ответа', 'quiet-hours': 'тихие часы',
    'daily-limit': 'достигнут дневной лимит', 'too-soon-after-last': 'слишком рано после прошлого сообщения',
    'silence-unknown': 'не удалось определить время последнего сообщения', 'conversation-is-live': 'беседа ещё идёт',
    'idle-check-daily-cap': 'лимит проверок инициативы на сегодня', 'idle-check-interval': 'ещё рано для новой проверки',
    'no-reason-to-write': 'нет повода (нет целей и мыслей)', 'model-decided-not-to-write': 'персонаж решил пока не писать',
    'user-replied': 'вы ответили раньше', sent: 'сообщение отправлено',
};
const initiativeText = (r) => !r ? '—' : (INITIATIVE_RU[r] || r);
const PROFILE_TYPE_RU = { current: 'текущая модель ST', 'st-profile': 'профиль Connection Manager', openai: 'OpenAI-совместимый эндпоинт' };
const SKIP_RU = {
    disabled: 'автономность выключена', paused: 'фон приостановлен', busy: 'идёт цикл', backoff: 'пауза после ошибки',
    'no-chat': 'нет открытого чата с одним персонажем', 'main-generation-in-progress': 'идёт основная генерация',
    'character-disabled': 'для этого персонажа выключено', 'nothing-enabled': 'дневник и память выключены',
    'waiting-for-quiet': 'ждёт паузы в беседе', interval: 'ещё не прошёл минимальный интервал',
    'baseline-set': 'установлена начальная точка чата', 'discarded-chat-changed': 'результат отброшен: сменился чат',
    'no-new-messages': 'нет новых сообщений', aborted: 'прервано',
};
const skipText = (r) => !r ? '' : r.startsWith('initiative: ') ? `инициатива: ${initiativeText(r.slice(12))}` : (SKIP_RU[r] || (r.startsWith('not-enough-new-messages') ? `мало новых сообщений ${r.slice(r.indexOf('('))}` : r));

export function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid == null || kid === false) continue;
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

const btn = (label, onClick, extra = '') => h('div', { class: `menu_button il-btn ${extra}`, role: 'button', tabindex: '0', onClick }, label);

function select(options, value, onChange) {
    const el = h('select', { class: 'text_pole il-select', onChange: (e) => onChange(e.target.value) },
        options.map(([v, t]) => h('option', { value: v }, t)));
    el.value = value;
    return el;
}

function download(text, name, type = 'application/json') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function confirmDialog(text) {
    const c = ctx();
    const r = await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM);
    return r === c.POPUP_RESULT.AFFIRMATIVE || r === true;
}

let current = null; // { render } while the panel is open

export function refreshPanel() { current?.render(); }

/**
 * app = { getSettings, saveSettings, engine, currentCharacter, loadChar, saveChar, deleteCharData,
 *         exportJson, computeInjection, onChange }
 */
export async function openPanel(app) {
    if (current) return;
    const state = {
        tab: 'overview',
        diary: { q: '', scope: 'all', order: 'desc', editing: null },
        memory: { q: '', type: '', status: 'active', editing: null, history: new Set(), adding: false },
        goals: { status: 'active', editing: null, history: new Set(), showResolvedUnsaid: false },
        models: { editing: null, test: {} },
        preview: '',
    };
    const root = h('div', { class: 'il-root' });
    const tabsBar = h('div', { class: 'il-tabs' });
    const body = h('div', { class: 'il-body' });
    root.append(h('h3', { class: 'il-title', text: 'Inner Life' }), tabsBar, body);

    const settings = () => app.getSettings();
    const changed = () => { sanitizeSettings(settings()); app.saveSettings(); app.onChange?.(); };
    let renderToken = 0;

    // ---------- small form helpers ----------
    const field = (label, control, hint) => h('div', { class: 'il-field' }, h('label', { class: 'il-label' }, label), control, hint && h('small', { class: 'il-muted' }, hint));
    const num = (obj, key, { step = 1, hint, label }) => field(label, h('input', {
        class: 'text_pole', type: 'number', step, value: obj[key],
        onChange: (e) => { obj[key] = Number(e.target.value); changed(); render(); },
    }), hint);
    const check = (label, obj, key, after) => h('label', { class: 'checkbox_label il-check' },
        h('input', { type: 'checkbox', checked: obj[key], onChange: (e) => { obj[key] = e.target.checked; changed(); after?.(); } }), h('span', {}, label));

    // ---------- tabs ----------
    const TABS = [['overview', 'Обзор'], ['diary', 'Дневник'], ['memory', 'Память'], ['goals', 'Цели'], ['initiative', 'Инициатива'], ['heartbeat', 'Heartbeat'], ['models', 'Модели'], ['settings', 'Настройки']];
    function drawTabs() {
        tabsBar.replaceChildren(...TABS.map(([id, label]) => h('div', {
            class: `menu_button il-tab ${state.tab === id ? 'il-tab-active' : ''}`, role: 'button', tabindex: '0',
            onClick: () => { state.tab = id; render(); },
        }, label)));
    }

    async function render() {
        const token = ++renderToken;
        drawTabs();
        const cur = app.currentCharacter();
        let data = null;
        let err = null;
        if (cur) { try { data = await app.loadChar(cur.avatar, cur.name); } catch (e) { err = e; } }
        if (token !== renderToken) return;
        let node;
        if (state.tab === 'models') node = tabModels();
        else if (err) node = h('div', { class: 'il-warn' }, `Не удалось загрузить данные персонажа: ${err.message}`);
        else if (!cur || !data) node = h('div', { class: 'il-muted' }, 'Откройте чат с одним персонажем (групповые чаты в этой версии не поддерживаются). Вкладка «Модели» доступна и без чата.');
        else node = ({ overview: tabOverview, diary: tabDiary, memory: tabMemory, goals: tabGoals, initiative: tabInitiative, heartbeat: tabHeartbeat, settings: tabSettings })[state.tab](cur, data);
        body.replaceChildren(node);
    }

    // ---------- overview ----------
    function tabOverview(cur, data) {
        const s = settings(), cs = getCharSettings(s, cur.avatar), st = app.engine.getStatus(), sc = stats(data), u = s.usage;
        const status = !s.enabled ? 'Автономность выключена (общий переключатель)'
            : !cs.enabled ? `Для «${cur.name}» выключено`
            : st.running ? 'Идёт внутренний цикл…'
            : st.paused ? 'Приостановлено (после ошибок или вручную)'
            : `Активно${st.lastSkip ? ` — ${skipText(st.lastSkip)}` : ''}`;
        return h('div', {},
            h('div', { class: 'il-card' },
                h('div', { class: 'il-strong' }, `${cur.name}: ${status}`),
                h('div', { class: 'il-muted' }, `Настроение: ${data.state.mood || '—'}`),
                h('div', { class: 'il-muted' }, `На уме: ${data.state.workingNote || '—'}`),
                h('div', { class: 'il-muted' }, `Дневник: ${sc.diary} · Память: ${sc.memoriesActive} активных, ${sc.memoriesArchived} в архиве · Целей активных: ${sc.goalsActive} · Недосказанного: ${sc.unsaidHeld}`),
                h('div', { class: 'il-muted' }, `Инициатива: ${s.initiative.mode === 'off' || !cs.initiative ? 'выключена' : `режим «${s.initiative.mode}», сегодня отправлено ${data.state.initiative.day === dayKey(Date.now()) ? data.state.initiative.sent : 0}`}`),
                h('div', { class: 'il-muted' }, `Последний цикл: ${formatDateTime(data.state.lastCycleTs)}${st.lastResult ? ` — ${st.lastResult.summary}` : ''}`),
                h('div', { class: 'il-muted' }, `Сегодня фоновых вызовов: ${u.dayCalls}${s.limits.maxCallsPerDay ? ` из ${s.limits.maxCallsPerDay}` : ''}`),
                st.lastError && h('div', { class: 'il-warn' }, `Последняя ошибка: ${st.lastError}`),
            ),
            h('div', { class: 'il-row' },
                check('Включить Inner Life (общий)', s, 'enabled', render),
                check(`Включить для «${cur.name}»`, cs, 'enabled', render),
            ),
            h('div', { class: 'il-row' },
                btn('Запустить цикл сейчас', async () => {
                    if (!s.enabled || !cs.enabled) return toast('info', 'Сначала включите Inner Life и персонажа.');
                    toast('info', 'Цикл запущен…');
                    const r = await app.engine.runCycle({ manual: true });
                    toast(r.status === 'ok' ? 'success' : r.status === 'error' ? 'error' : 'info', r.summary || r.error || skipText(r.reason) || r.reason);
                    render();
                }),
                st.paused && btn('Возобновить фон', () => { app.engine.resume(); render(); }),
            ),
            h('h4', {}, 'Журнал активности'),
            h('div', { class: 'il-log' }, [...data.state.log].reverse().slice(0, 15).map(l =>
                h('div', { class: l.ok ? 'il-muted' : 'il-warn' }, `${formatDateTime(l.ts)} · ${l.summary}`)),
            data.state.log.length === 0 && h('div', { class: 'il-muted' }, 'Пока пусто.')),
        );
    }

    // ---------- diary ----------
    function tabDiary(cur, data) {
        const d = state.diary;
        const entries = searchDiary(data, { query: d.q, chatId: d.scope === 'chat' ? cur.chatId : '', order: d.order });
        return h('div', {},
            h('div', { class: 'il-row' },
                h('input', { class: 'text_pole il-grow', type: 'search', placeholder: 'Поиск по дневнику…', value: d.q, onChange: (e) => { d.q = e.target.value; render(); } }),
                select([['all', 'Все чаты'], ['chat', 'Этот чат']], d.scope, (v) => { d.scope = v; render(); }),
                select([['desc', 'Сначала новые'], ['asc', 'Сначала старые']], d.order, (v) => { d.order = v; render(); }),
            ),
            h('div', { class: 'il-muted' }, `Записей: ${entries.length} из ${data.diary.length}`),
            entries.length === 0 && h('div', { class: 'il-muted il-card' }, 'Записей нет. Персонаж пишет в дневник только когда случается что-то значимое.'),
            entries.map(e => h('div', { class: 'il-card' },
                h('div', { class: 'il-muted' }, `${formatDateTime(e.ts)}${e.mood ? ` · ${e.mood}` : ''}${e.tags.length ? ` · #${e.tags.join(' #')}` : ''}${e.edited ? ' · изменено вами' : ''}`),
                revisitNote(e, data),
                d.editing === e.id
                    ? h('div', {}, h('textarea', { class: 'text_pole il-textarea', id: 'il-diary-edit', value: e.text }),
                        h('div', { class: 'il-row' },
                            btn('Сохранить', () => { updateDiaryEntry(data, e.id, document.getElementById('il-diary-edit').value); app.saveChar(data); d.editing = null; render(); }),
                            btn('Отмена', () => { d.editing = null; render(); })))
                    : h('div', { class: 'il-text' }, e.text),
                d.editing !== e.id && h('div', { class: 'il-row' },
                    btn('Изменить', () => { d.editing = e.id; render(); }),
                    btn('Удалить', async () => { if (await confirmDialog('Удалить эту запись дневника?')) { deleteDiaryEntry(data, e.id); app.saveChar(data); render(); } }),
                ))),
        );
    }

    function revisitNote(e, data) {
        const parts = [];
        if (e.revisit) {
            const orig = data.diary.find(x => x.id === e.revisit.of);
            parts.push(h('div', { class: 'il-revisit' }, `↩ ${STANCE_RU[e.revisit.stance] || 'возвращается к'} запись${orig ? ` от ${formatDateTime(orig.ts)}: «${orig.text.slice(0, 90)}${orig.text.length > 90 ? '…' : ''}»` : ' (она была удалена)'}`));
        }
        if (e.revisedBy?.length) parts.push(h('div', { class: 'il-revisit' }, `🔁 Позже пересмотрено (${e.revisedBy.length}). Эта запись осталась без изменений.`));
        return parts;
    }

    // ---------- memory ----------
    function tabMemory(cur, data) {
        const m = state.memory;
        const q = m.q.trim().toLowerCase();
        const list = data.memories
            .filter(x => (m.status === 'all' || x.status === m.status) && (!m.type || x.type === m.type) && (!q || x.text.toLowerCase().includes(q) || x.tags.some(t => t.toLowerCase().includes(q))))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const typeOpts = [['', 'Все типы'], ...MEMORY_TYPES.map(t => [t, TYPE_RU[t]])];
        return h('div', {},
            h('div', { class: 'il-row' },
                h('input', { class: 'text_pole il-grow', type: 'search', placeholder: 'Поиск по памяти…', value: m.q, onChange: (e) => { m.q = e.target.value; render(); } }),
                select(typeOpts, m.type, (v) => { m.type = v; render(); }),
                select([['active', 'Активные'], ['archived', 'Архив'], ['all', 'Все']], m.status, (v) => { m.status = v; render(); }),
            ),
            h('div', { class: 'il-row' }, btn(m.adding ? 'Скрыть форму' : '＋ Добавить воспоминание вручную', () => { m.adding = !m.adding; render(); })),
            m.adding && h('div', { class: 'il-card' },
                h('textarea', { class: 'text_pole il-textarea', id: 'il-mem-new', placeholder: 'Одно конкретное предложение с точки зрения персонажа' }),
                h('div', { class: 'il-row' }, select(typeOpts.slice(1), 'semantic', (v) => { m.newType = v; }),
                    btn('Добавить', () => {
                        const r = addMemory(data, { text: document.getElementById('il-mem-new').value, type: m.newType || 'semantic', confidence: 'confirmed', importance: 4, from: 'user', chatId: cur.chatId }, Date.now(), { similarityThreshold: settings().memory.similarityThreshold });
                        if (r.action === 'skipped') return toast('warning', 'Слишком короткий текст.');
                        app.saveChar(data); m.adding = false; render();
                    }))),
            h('div', { class: 'il-muted' }, `Показано: ${list.length}`),
            list.length === 0 && h('div', { class: 'il-muted il-card' }, 'Воспоминаний нет.'),
            list.map(x => memoryCard(x, data)),
        );
    }

    function memoryCard(x, data) {
        const m = state.memory;
        const badges = h('div', { class: 'il-badges' },
            h('span', { class: 'il-badge' }, TYPE_RU[x.type]), h('span', { class: `il-badge il-conf-${x.confidence}` }, CONF_RU[x.confidence]),
            h('span', { class: 'il-badge' }, `важность ${x.importance}`), x.pinned && h('span', { class: 'il-badge' }, '📌'),
            x.userEdited && h('span', { class: 'il-badge' }, 'правка пользователя'), x.status === 'archived' && h('span', { class: 'il-badge' }, 'архив'),
            h('span', { class: 'il-muted' }, formatDateTime(x.updatedAt)));
        if (m.editing === x.id) {
            const draft = { type: x.type, confidence: x.confidence, importance: x.importance };
            return h('div', { class: 'il-card' }, badges,
                h('textarea', { class: 'text_pole il-textarea', id: 'il-mem-edit', value: x.text }),
                h('div', { class: 'il-row' },
                    select(MEMORY_TYPES.map(t => [t, TYPE_RU[t]]), x.type, v => { draft.type = v; }),
                    select(CONFIDENCE.map(t => [t, CONF_RU[t]]), x.confidence, v => { draft.confidence = v; }),
                    h('input', { class: 'text_pole il-small', type: 'number', min: 1, max: 5, value: x.importance, onChange: e => { draft.importance = Number(e.target.value); } })),
                h('div', { class: 'il-row' },
                    btn('Сохранить', () => { updateMemory(data, x.id, { text: document.getElementById('il-mem-edit').value, ...draft }, Date.now(), { by: 'user' }); app.saveChar(data); m.editing = null; render(); }),
                    btn('Отмена', () => { m.editing = null; render(); })));
        }
        return h('div', { class: 'il-card' }, badges, h('div', { class: 'il-text' }, x.text),
            m.history.has(x.id) && h('div', { class: 'il-history' }, x.history.map(hh => h('div', { class: 'il-muted' }, `${formatDateTime(hh.ts)} (${hh.by || 'система'}, ${hh.reason}): ${hh.text}`))),
            h('div', { class: 'il-row' },
                btn('Изменить', () => { m.editing = x.id; render(); }),
                btn(x.pinned ? 'Открепить' : 'Закрепить', () => { updateMemory(data, x.id, { pinned: !x.pinned }, Date.now(), { by: 'user' }); app.saveChar(data); render(); }),
                btn(x.status === 'active' ? 'В архив' : 'Вернуть', () => { updateMemory(data, x.id, { status: x.status === 'active' ? 'archived' : 'active' }, Date.now(), { by: 'user' }); app.saveChar(data); render(); }),
                x.history.length > 0 && btn(m.history.has(x.id) ? 'Скрыть историю' : `История (${x.history.length})`, () => { m.history.has(x.id) ? m.history.delete(x.id) : m.history.add(x.id); render(); }),
                btn('Удалить', async () => { if (await confirmDialog('Удалить воспоминание безвозвратно?')) { deleteMemory(data, x.id); app.saveChar(data); render(); } })));
    }

    // ---------- goals ----------
    function tabGoals(cur, data) {
        const s = settings(), vis = s.goals.visibility, g = state.goals;
        const visSel = field('Что вы видите о целях и недосказанном', select([['full', 'Всё (причины, критерии, прогресс)'], ['summary', 'Только формулировки'], ['hidden', 'Скрыть (персонаж всё равно их преследует)']], vis, v => { s.goals.visibility = v; changed(); render(); }),
            'Это влияет только на панель. Автономная логика персонажа от этого не меняется.');
        const active = getActiveGoals(data).length;
        if (vis === 'hidden') {
            return h('div', {}, visSel, h('div', { class: 'il-card il-muted' }, `Цели и недосказанное скрыты. Сейчас у персонажа активных целей: ${active}, недосказанного: ${heldUnsaid(data).length}.`));
        }
        const full = vis === 'full';
        const order = { active: 0, paused: 1, done: 2, dropped: 3 };
        const list = data.goals.filter(x => g.status === 'all' || x.status === g.status)
            .sort((a, b) => order[a.status] - order[b.status] || b.priority - a.priority || b.updatedAt - a.updatedAt);
        const parentOf = (x) => x.parentId ? data.goals.find(p => p.id === x.parentId) : null;
        return h('div', {},
            visSel,
            h('div', { class: 'il-row' }, select([['active', 'Активные'], ['paused', 'На паузе'], ['done', 'Достигнутые'], ['dropped', 'Отменённые'], ['all', 'Все']], g.status, v => { g.status = v; render(); })),
            h('div', { class: 'il-muted' }, `Показано: ${list.length}. Цели ставит и закрывает сам персонаж; ваши действия (пауза, отмена, правка) он менять не может.`),
            list.length === 0 && h('div', { class: 'il-muted il-card' }, 'Целей нет. Это нормально: персонаж не обязан постоянно к чему-то стремиться.'),
            list.map(x => goalCard(x, data, full, parentOf(x))),
            unsaidSection(data, full),
        );
    }

    function unsaidSection(data, full) {
        const g = state.goals;
        const items = data.unsaid.filter(u => g.showResolvedUnsaid || u.status === 'held').sort((a, b) => b.updatedAt - a.updatedAt);
        return h('div', {},
            h('h4', {}, 'Недосказанное'),
            h('div', { class: 'il-muted' }, 'То, что персонаж хотел сказать или спросить, но сдержался. Оно может прозвучать позже в ответе или в сообщении первым, либо забыться само.'),
            h('div', { class: 'il-row' }, check('Показывать и уже высказанное', g, 'showResolvedUnsaid', render)),
            items.length === 0 && h('div', { class: 'il-muted il-card' }, 'Сейчас ничего не недосказано.'),
            items.map(u => h('div', { class: 'il-card' },
                h('div', { class: 'il-badges' }, h('span', { class: 'il-badge' }, UNSAID_RU[u.status]), h('span', { class: 'il-muted' }, formatDateTime(u.updatedAt))),
                h('div', { class: 'il-text' }, u.text),
                full && u.why && h('div', { class: 'il-muted' }, `Почему сдержался: ${u.why}`),
                full && u.note && h('div', { class: 'il-muted' }, u.note),
                h('div', { class: 'il-row' },
                    u.status === 'held' && btn('Убрать', () => { resolveUnsaid(data, [u.id], Date.now(), 'dropped', 'removed by user'); app.saveChar(data); render(); }),
                    btn('Удалить', async () => { if (await confirmDialog('Удалить запись о недосказанном?')) { deleteUnsaid(data, u.id); app.saveChar(data); render(); } })))));
    }

    function goalCard(x, data, full, parent) {
        const g = state.goals;
        const badges = h('div', { class: 'il-badges' },
            h('span', { class: 'il-badge' }, GOAL_KIND_RU[x.kind]), h('span', { class: 'il-badge' }, GOAL_STATUS_RU[x.status]),
            h('span', { class: 'il-badge' }, `приоритет ${x.priority}`), x.locked && h('span', { class: 'il-badge' }, '🔒 ваше решение'),
            h('span', { class: 'il-muted' }, formatDateTime(x.updatedAt)));
        if (g.editing === x.id) {
            return h('div', { class: 'il-card' }, badges,
                h('textarea', { class: 'text_pole il-textarea', id: 'il-goal-edit', value: x.text }),
                h('div', { class: 'il-row' },
                    btn('Сохранить', () => { userEditGoal(data, x.id, document.getElementById('il-goal-edit').value, Date.now()); app.saveChar(data); g.editing = null; render(); }),
                    btn('Отмена', () => { g.editing = null; render(); })));
        }
        const open = x.status === 'active' || x.status === 'paused';
        const setStatus = (st) => { userSetGoalStatus(data, x.id, st, Date.now()); app.saveChar(data); render(); };
        return h('div', { class: 'il-card' }, badges,
            parent && h('div', { class: 'il-muted' }, `Часть цели: ${parent.text}`),
            h('div', { class: 'il-text' }, x.text),
            full && x.reason && h('div', { class: 'il-muted' }, `Почему: ${x.reason}`),
            full && x.criteria && h('div', { class: 'il-muted' }, `Будет достигнута, когда: ${x.criteria}`),
            full && x.progress && h('div', { class: 'il-muted' }, `Прогресс: ${x.progress}`),
            full && x.evidence.map(e => h('div', { class: 'il-ok' }, `Основание завершения: ${e.text}`)),
            full && g.history.has(x.id) && h('div', { class: 'il-history' }, x.history.map(hh => h('div', { class: 'il-muted' }, `${formatDateTime(hh.ts)} · ${hh.by} · ${hh.event}${hh.note ? `: ${hh.note}` : ''}`))),
            h('div', { class: 'il-row' },
                x.status === 'active' && btn('Пауза', () => setStatus('paused')),
                x.status === 'paused' && btn('Возобновить', () => setStatus('active')),
                open && btn('Отменить', () => setStatus('dropped')),
                !open && btn('Вернуть в работу', () => {
                    if (getActiveGoals(data).length >= settings().goals.maxActive) return toast('warning', 'Слишком много активных целей.');
                    setStatus('active');
                }),
                btn('Изменить', () => { g.editing = x.id; render(); }),
                full && btn(g.history.has(x.id) ? 'Скрыть историю' : 'История', () => { g.history.has(x.id) ? g.history.delete(x.id) : g.history.add(x.id); render(); }),
                btn('Удалить', async () => { if (await confirmDialog('Удалить цель безвозвратно?')) { deleteGoal(data, x.id); app.saveChar(data); render(); } })));
    }

    // ---------- initiative ----------
    function tabInitiative(cur, data) {
        const s = settings(), n = s.initiative, cs = getCharSettings(s, cur.avatar), st = data.state.initiative, eng = app.engine.getStatus();
        const today = st.day === dayKey(Date.now());
        return h('div', {},
            h('div', { class: 'il-card' },
                h('div', { class: 'il-strong' }, n.mode === 'off' ? 'Выключено: персонаж никогда не пишет первым' : cs.initiative ? `Режим: ${({ rare: 'редкая', moderate: 'умеренная', custom: 'настраиваемая' })[n.mode]}` : `Для «${cur.name}» выключено`),
                h('div', { class: 'il-muted' }, `Отправлено сегодня: ${today ? st.sent : 0} · проверок сегодня: ${today ? st.idleChecks : 0}`),
                h('div', { class: 'il-muted' }, `Последнее сообщение первым: ${formatDateTime(st.lastSentTs)}`),
                h('div', { class: 'il-muted' }, `Последнее решение: ${initiativeText(eng.lastInitiative)}`)),
            h('div', { class: 'il-row' }, check(`Разрешить «${cur.name}» писать первым`, cs, 'initiative', render)),
            field('Режим инициативы', select([['off', 'Выключена'], ['rare', 'Редкая (не чаще 2 в день, раз в 4 ч)'], ['moderate', 'Умеренная (до 5 в день, раз в 1,5 ч)'], ['custom', 'Настраиваемая']], n.mode, v => { n.mode = v; changed(); render(); })),
            n.mode === 'custom' && num(n, 'customMinGapMin', { label: 'Минимум минут между сообщениями' }),
            n.mode === 'custom' && num(n, 'customMaxPerDay', { label: 'Максимум сообщений в день' }),
            num(n, 'minSilenceMin', { label: 'Писать только после тишины (мин)', hint: 'Пока беседа идёт, персонаж не перебивает.' }),
            num(n, 'quietStart', { label: 'Тихие часы: с (час, 0–23)' }),
            num(n, 'quietEnd', { label: 'Тихие часы: до (час, 0–23)', hint: 'Одинаковые значения отключают тихие часы. Можно через полночь (например, 23 → 8).' }),
            num(n, 'maxUnanswered', { label: 'Максимум сообщений подряд без вашего ответа' }),
            num(n, 'idleCheckMin', { label: 'Как часто можно проверять «не написать ли первым» (мин)' }),
            num(n, 'maxIdleChecksPerDay', { label: 'Максимум таких проверок в сутки', hint: 'Каждая проверка — один короткий вызов модели; решение «писать» добавляет ещё один. Условия выше проверяются до вызова бесплатно.' }),
            h('div', { class: 'il-row' }, btn('Проверить сейчас (тест)', async () => {
                if (!s.enabled || !cs.enabled || !cs.initiative || n.mode === 'off') return toast('info', 'Включите Inner Life, персонажа, «Разрешить писать первым» и выберите режим.');
                toast('info', 'Генерирую сообщение…');
                const r = await app.engine.runInitiative({ manual: true });
                toast(r.status === 'ok' ? 'success' : r.status === 'error' ? 'error' : 'info', r.summary || r.error || skipText(r.reason) || r.reason);
                render();
            })),
            h('small', { class: 'il-muted' }, 'Тест пропускает решение модели и правило тишины, но не пишет, пока вы набираете сообщение или идёт генерация. Автоматические сообщения возможны только пока открыта вкладка SillyTavern; они добавляются в чат так же, как команда /sendas, и помечаются как инициатива.'),
        );
    }

    // ---------- heartbeat ----------
    function tabHeartbeat(cur, data) {
        const s = settings(), hb = s.heartbeat, l = s.limits, u = s.usage, st = app.engine.getStatus();
        return h('div', {},
            h('div', { class: 'il-card' },
                h('div', { class: 'il-strong' }, st.running ? 'Выполняется цикл…' : st.paused ? 'Приостановлен' : 'Ожидает событий'),
                h('div', { class: 'il-muted' }, `Причина простоя: ${skipText(st.lastSkip) || '—'}`),
                st.backoffUntil > Date.now() && h('div', { class: 'il-warn' }, `Пауза после ошибки до ${formatDateTime(st.backoffUntil)}`),
                st.lastError && h('div', { class: 'il-warn' }, `Ошибка: ${st.lastError}`),
                h('div', { class: 'il-muted' }, `Вызовов за этот час: ${u.hourCalls}${l.maxCallsPerHour ? `/${l.maxCallsPerHour}` : ''} · за сутки: ${u.dayCalls}${l.maxCallsPerDay ? `/${l.maxCallsPerDay}` : ''} · токенов вывода (оценка): ${u.dayOutTokens}${l.maxOutputTokensPerDay ? `/${l.maxOutputTokensPerDay}` : ''}`)),
            h('div', { class: 'il-row' },
                btn('Запустить сейчас', async () => { const r = await app.engine.runCycle({ manual: true }); toast(r.status === 'ok' ? 'success' : 'info', r.summary || r.error || skipText(r.reason) || r.reason); render(); }),
                btn(hb.paused ? 'Возобновить' : 'Приостановить', () => { if (hb.paused) app.engine.resume(); else { hb.paused = true; changed(); } render(); }),
                btn('Сбросить счётчики', () => { s.usage.dayCalls = 0; s.usage.hourCalls = 0; s.usage.dayInTokens = 0; s.usage.dayOutTokens = 0; changed(); render(); })),
            h('h4', {}, 'Когда думать'),
            num(hb, 'intervalMin', { label: 'Минимальный интервал между циклами (мин)', hint: 'Это нижняя граница. Цикл запускается событиями (новые сообщения), а не таймером вслепую.' }),
            num(hb, 'minNewMessages', { label: 'Минимум новых сообщений для цикла', hint: 'Ниже порога модель не вызывается вообще.' }),
            num(hb, 'debounceSec', { label: 'Ждать паузы в беседе (сек)' }),
            num(hb, 'maxContextMessages', { label: 'Сколько последних сообщений отдавать модели' }),
            num(hb, 'maxOutputTokens', { label: 'Лимит токенов ответа для дневника/памяти' }),
            num(hb, 'diaryMinGapMin', { label: 'Минимум минут между записями в дневник' }),
            h('h4', {}, 'Расходы'),
            check('Разрешить фоновые вызовы модели (выключатель платных вызовов)', l, 'backgroundCallsEnabled', render),
            num(l, 'maxCallsPerHour', { label: 'Вызовов в час (0 = без лимита)' }),
            num(l, 'maxCallsPerDay', { label: 'Вызовов в сутки (0 = без лимита)' }),
            num(l, 'maxOutputTokensPerDay', { label: 'Токенов вывода в сутки, оценка (0 = без лимита)' }),
            h('small', { class: 'il-muted' }, 'Счётчики ведутся локально и по оценке (≈ символы/3.6); счёт провайдера может отличаться. Heartbeat работает, только пока открыта вкладка SillyTavern.'),
        );
    }

    // ---------- models ----------
    function tabModels() {
        const s = settings();
        const profOpts = s.models.profiles.map(p => [p.id, p.name]);
        const editing = s.models.profiles.find(p => p.id === state.models.editing);
        return h('div', {},
            h('h4', {}, 'Какая модель что делает'),
            ...Object.keys(TASK_RU).map(task => field(TASK_RU[task], select(profOpts, s.models.assign[task], v => { s.models.assign[task] = v; changed(); }))),
            h('small', { class: 'il-muted' }, 'Основные ответы пользователю по-прежнему генерирует ваша основная модель SillyTavern. Здесь настраиваются только фоновые задачи.'),
            h('h4', {}, 'Профили моделей'),
            s.models.profiles.map(p => h('div', { class: 'il-card' },
                h('div', { class: 'il-strong' }, p.name), h('div', { class: 'il-muted' }, PROFILE_TYPE_RU[p.type] + (p.type === 'openai' ? ` · ${p.model || 'модель не указана'}` : '')),
                state.models.test[p.id] && h('div', { class: state.models.test[p.id].ok ? 'il-ok' : 'il-warn' }, state.models.test[p.id].text),
                h('div', { class: 'il-row' },
                    !p.builtin && btn('Изменить', () => { state.models.editing = state.models.editing === p.id ? null : p.id; render(); }),
                    btn('Проверить соединение', async () => {
                        state.models.test[p.id] = { ok: true, text: 'Проверка…' }; render();
                        const r = await testProfile(p, collectSecrets(s));
                        state.models.test[p.id] = { ok: r.ok, text: r.ok ? `OK · ${r.ms} мс · «${r.text}»` : `Ошибка: ${r.error}` }; render();
                    }),
                    !p.builtin && btn('Удалить', async () => {
                        if (!(await confirmDialog(`Удалить профиль «${p.name}»?`))) return;
                        s.models.profiles = s.models.profiles.filter(x => x.id !== p.id);
                        for (const t of Object.keys(s.models.assign)) if (s.models.assign[t] === p.id) s.models.assign[t] = CURRENT_PROFILE_ID;
                        setSessionKey(p.id, ''); changed(); render();
                    })))),
            editing && profileForm(editing),
            h('div', { class: 'il-row' },
                btn('＋ Свой эндпоинт (OpenAI-совместимый)', () => { const p = newProfile('openai'); s.models.profiles.push(p); state.models.editing = p.id; changed(); render(); }),
                btn('＋ Профиль Connection Manager', () => { const p = newProfile('st-profile'); s.models.profiles.push(p); state.models.editing = p.id; changed(); render(); })),
            h('div', { class: 'il-warn il-small-text' }, 'Безопасность: ключ из этой формы хранится в настройках SillyTavern (settings.json на сервере) открытым текстом — штатного шифрования для сторонних расширений у SillyTavern нет. Если не хотите хранить ключ, снимите галочку «Хранить ключ» — тогда он живёт только до перезагрузки страницы. Свой эндпоинт получает фрагменты вашего чата и карточки персонажа: используйте только те, которым доверяете. Запросы идут через сервер SillyTavern.'),
        );
    }

    function profileForm(p) {
        const set = (k, v) => { p[k] = v; changed(); };
        const text = (k, label, opts = {}) => field(label, h('input', { class: 'text_pole', type: opts.type || 'text', placeholder: opts.ph || '', value: p[k] ?? '', onChange: e => { set(k, opts.number ? Number(e.target.value) : e.target.value.trim()); } }), opts.hint);
        let body;
        if (p.type === 'st-profile') {
            let profs = [];
            try { profs = ctx().ConnectionManagerRequestService.getSupportedProfiles(); } catch (e) { /* extension disabled */ }
            body = [profs.length
                ? field('Профиль Connection Manager', select([['', '— выберите —'], ...profs.map(x => [x.id, x.name])], p.stProfileId, v => set('stProfileId', v)))
                : h('div', { class: 'il-warn' }, 'Профили не найдены. Включите расширение Connection Manager и создайте профиль (там же задаются прокси и ключи).')];
        } else {
            body = [
                text('baseUrl', 'Base URL', { ph: 'https://my-proxy.example.com/v1', hint: 'Адрес до /v1 (без /chat/completions). Формат OpenAI Chat Completions.' }),
                field('API-ключ / пароль прокси', h('input', {
                    class: 'text_pole', type: 'password', autocomplete: 'off', placeholder: hasKey(p) ? '•••••••• (сохранён, введите новый для замены)' : 'ключ',
                    onChange: e => { const v = e.target.value.trim(); if (!v) return; if (p.persistKey) p.apiKey = v; else { p.apiKey = ''; setSessionKey(p.id, v); } changed(); e.target.value = ''; render(); },
                })),
                h('label', { class: 'checkbox_label il-check' }, h('input', {
                    type: 'checkbox', checked: p.persistKey, onChange: e => {
                        const key = getKey(p);
                        p.persistKey = e.target.checked;
                        if (p.persistKey) { p.apiKey = key; setSessionKey(p.id, ''); } else { setSessionKey(p.id, key); p.apiKey = ''; }
                        changed(); render();
                    },
                }), h('span', {}, 'Хранить ключ в настройках SillyTavern')),
                text('model', 'Название модели', { ph: 'gpt-4o-mini' }),
                text('temperature', 'Temperature', { type: 'number', number: true }),
                text('maxTokens', 'Макс. токенов ответа (верхняя граница)', { type: 'number', number: true }),
                text('timeoutSec', 'Таймаут (сек)', { type: 'number', number: true }),
                text('retries', 'Повторов при сбоях сети (0–3)', { type: 'number', number: true }),
            ];
        }
        return h('div', { class: 'il-card il-edit' }, h('div', { class: 'il-strong' }, `Редактирование: ${p.name}`), text('name', 'Название профиля'), body,
            btn('Готово', () => { state.models.editing = null; render(); }));
    }

    // ---------- settings ----------
    function tabSettings(cur, data) {
        const s = settings(), cs = getCharSettings(s, cur.avatar), i = s.injection, mem = s.memory, pr = s.privacy;
        const previewBox = h('pre', { class: 'il-preview' }, state.preview || '');
        return h('div', {},
            h('h4', {}, 'Что включено'),
            check('Inner Life включён (общий переключатель)', s, 'enabled', render),
            h('div', { class: 'il-muted' }, `Для «${cur.name}»:`),
            check('Автономность персонажа', cs, 'enabled', render),
            check('Вести дневник', cs, 'diary'),
            check('Формировать память', cs, 'memory'),
            check('Ставить себе цели', cs, 'goals'),
            check('Держать в себе недосказанное', cs, 'unsaid'),
            check('Писать первым (см. вкладку «Инициатива»)', cs, 'initiative'),
            check('Подмешивать память в ответы (инъекция в промпт)', cs, 'inject'),
            h('h4', {}, 'Приватность'),
            check('Отправлять фоновым моделям описание/личность персонажа', pr, 'sendCharacterCard'),
            num(pr, 'cardChars', { label: 'Сколько символов карточки отправлять' }),
            h('h4', {}, 'Память'),
            num(mem, 'maxActive', { label: 'Максимум активных воспоминаний (лишние архивируются, не удаляются)' }),
            num(mem, 'maxPerCycle', { label: 'Максимум новых воспоминаний за цикл' }),
            num(mem, 'similarityThreshold', { label: 'Порог схожести для объединения дубликатов (0.3–0.95)', step: 0.01 }),
            h('h4', {}, 'Осознание времени'),
            check('Замечать долгие паузы между сообщениями', s.awareness, 'timeGaps'),
            num(s.awareness, 'gapMinHours', { label: 'Считать паузой от (часов)', hint: 'Считается локально, без вызова модели. Персонаж реагирует на возвращение в духе своего характера.' }),
            h('h4', {}, 'Недосказанное'),
            num(s.unsaid, 'maxHeld', { label: 'Максимум одновременно удерживаемых мыслей' }),
            num(s.unsaid, 'expireDays', { label: 'Через сколько дней непрозвучавшее забывается' }),
            h('h4', {}, 'Цели'),
            num(s.goals, 'maxActive', { label: 'Максимум активных целей' }),
            num(s.goals, 'maxNewPerDay', { label: 'Максимум новых целей в сутки (защита от зацикливания)' }),
            num(s.goals, 'staleDays', { label: 'Через сколько дней без движения цель устаревает' }),
            h('h4', {}, 'Подмешивание в основной промпт'),
            check('Включено', i, 'enabled'),
            num(i, 'depth', { label: 'Глубина вставки (0 = в самый конец)' }),
            field('Роль сообщения', select([['system', 'system'], ['user', 'user'], ['assistant', 'assistant']], i.role, v => { i.role = v; changed(); })),
            num(i, 'maxChars', { label: 'Максимум символов вставки' }),
            num(i, 'memoryLimit', { label: 'Максимум воспоминаний во вставке' }),
            check('Добавлять последнюю запись дневника', i, 'includeDiary'),
            check('Добавлять активные цели (мягкие желания, не приказы)', i, 'includeGoals'),
            check('Добавлять недосказанное (может проскользнуть в ответе)', i, 'includeUnsaid'),
            num(i, 'diaryChars', { label: 'Длина фрагмента дневника (символов)' }),
            btn('Показать, что сейчас уходит в промпт', () => { state.preview = app.computeInjection() || '(пусто — вставка не формируется)'; previewBox.textContent = state.preview; }),
            previewBox,
            h('h4', {}, 'Данные'),
            h('div', { class: 'il-muted' }, `Файл: user/files/${fileNameForCharacter(cur.avatar)} (в папке данных SillyTavern; копируйте его для бэкапа и переноса).`),
            h('div', { class: 'il-row' },
                btn('Экспорт JSON', () => download(app.exportJson(data), `inner-life-${cur.name.replace(/[^\w.-]+/g, '_')}.json`)),
                btn('Удалить все данные персонажа', async () => {
                    if (!(await confirmDialog(`Удалить дневник, память и состояние «${cur.name}»? Это необратимо.`))) return;
                    await app.deleteCharData(cur.avatar); toast('success', 'Данные удалены.'); render();
                })),
        );
    }

    // ---------- open ----------
    current = { render };
    render();
    try {
        const c = ctx();
        await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Закрыть', cancelButton: false });
    } finally {
        current = null;
        renderToken++;
    }
}
