// Heartbeat engine: an economical decide-then-act loop. Pure logic; all I/O comes in through `deps`
// so the whole cycle can be unit-tested without SillyTavern.
//
// Two paths:
//   1. "cycle"  - after new chat messages: decide -> (diary | memory | goals) on separately configured models.
//   2. "idle"   - during silence: free deterministic gates -> cheap "should I write first?" decision -> compose -> send.
import { checkBudget, recordUsage } from './budget.js';
import { applyGoalOps, expireStaleGoals, getActiveGoals, getRecentlyClosed, isOpen, noteGoalProgress, pruneClosedGoals } from './goals.js';
import { canReachOut, cleanInitiativeText, idleCheckDue, recordIdleCheck, recordInitiativeSent } from './initiative.js';
import { buildComposePrompt, buildDiaryPrompt, buildGoalsPrompt, buildHeartbeatPrompt, buildIdlePrompt, buildMemoryPrompt, formatTranscript, normalizeDiaryResult, normalizeGoalOps, normalizeHeartbeatResult, normalizeIdleResult, normalizeMemoryResult } from './prompts.js';
import { getCharSettings, getProfileForTask } from './settings.js';
import { addDiaryEntry, addMemory, enforceMemoryLimit, pushLog, relevantDiary, retrieveMemories, updateMemory } from './store.js';
import { findGaps } from './time.js';
import { addUnsaid, expireUnsaid, heldUnsaid, pruneUnsaid, resolveUnsaid } from './unsaid.js';
import { estimateTokens, parseJsonLoose } from './util.js';

export const TICK_MS = 20000;
const MAX_FAILURES_BEFORE_PAUSE = 5;
const cycleEnabled = (cs) => cs.diary || cs.memory || cs.goals || cs.unsaid;

class BudgetError extends Error {
    constructor(reason) { super(`budget: ${reason}`); this.name = 'BudgetError'; this.reason = reason; }
}

/**
 * deps = {
 *   now(), getSettings(), saveSettings(), getSnapshot(), loadChar(avatar, name), saveChar(data),
 *   callModel(profile, {system, user, maxTokens, signal}) -> {text},
 *   sendMessage({snap, text, reason}) -> inserts a character message into the chat,
 *   onUpdate(), notify(level, msg), redact(text)
 * }
 * snapshot = { chatId, avatar, charName, userName, card, generating, composing, lastMessageAt,
 *              messages: [{idx, name, is_user, mes, initiative}] }
 */
export class HeartbeatEngine {
    constructor(deps) {
        this.deps = { onUpdate() {}, notify() {}, redact: (t) => t, sendMessage: async () => { throw new Error('sendMessage is not configured'); }, ...deps };
        this.timer = null;
        this.running = false;
        this.abort = null;
        this.lastMessageTs = 0;
        this.failures = 0;
        this.backoffUntil = 0;
        this.lastError = '';
        this.lastSkip = '';
        this.lastInitiative = '';
        this.lastResult = null;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => { this.tick().catch(e => console.error('[inner-life] tick failed', e)); }, TICK_MS);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.abort?.abort();
    }

    notifyMessage() { this.lastMessageTs = this.deps.now(); }

    notifyChatChanged() {
        this.abort?.abort();
        this.lastMessageTs = 0;
        this.lastSkip = '';
        this.lastInitiative = '';
        this.deps.onUpdate();
    }

    getStatus() {
        return {
            running: this.running,
            failures: this.failures,
            backoffUntil: this.backoffUntil,
            lastError: this.lastError,
            lastSkip: this.lastSkip,
            lastInitiative: this.lastInitiative,
            lastResult: this.lastResult,
            paused: !!this.deps.getSettings().heartbeat.paused,
        };
    }

    skip(reason) {
        this.lastSkip = reason;
        return { status: 'skipped', reason };
    }

    lastActivityAt(snap) {
        return Math.max(snap.lastMessageAt || 0, this.lastMessageTs || 0);
    }

    pending(data, snap, s) {
        const maxCtx = s.heartbeat.maxContextMessages;
        const lastIdx = snap.messages.length ? snap.messages[snap.messages.length - 1].idx : -1;
        const rec = data.state.processed[snap.chatId];
        let startIdx = rec ? rec.idx : Math.max(0, lastIdx - maxCtx + 1);
        if (startIdx > lastIdx + 1) startIdx = lastIdx + 1; // messages were deleted
        let fresh = snap.messages.filter(m => m.idx >= startIdx);
        if (fresh.length > maxCtx) fresh = fresh.slice(-maxCtx);
        return { rec, lastIdx, fresh };
    }

    /** Cheap, deterministic gate. Calls a model only when every condition holds. */
    async tick() {
        const { getSettings, getSnapshot, loadChar, now } = this.deps;
        const s = getSettings();
        const t = now();
        if (!s.enabled) return this.skip('disabled');
        if (s.heartbeat.paused) return this.skip('paused');
        if (this.running) return this.skip('busy');
        if (t < this.backoffUntil) return this.skip('backoff');
        const snap = getSnapshot();
        if (!snap) return this.skip('no-chat');
        if (snap.generating) return this.skip('main-generation-in-progress');
        const cs = getCharSettings(s, snap.avatar);
        if (!cs.enabled) return this.skip('character-disabled');
        const initiativeOn = cs.initiative && s.initiative.mode !== 'off';
        const cycleOn = cycleEnabled(cs);
        if (!cycleOn && !initiativeOn) return this.skip('nothing-enabled');

        const data = await loadChar(snap.avatar, snap.charName);
        let reason = 'nothing-to-do';
        if (cycleOn) {
            const info = this.pending(data, snap, s);
            const quiet = !(this.lastMessageTs && t - this.lastMessageTs < s.heartbeat.debounceSec * 1000);
            const intervalOk = t - data.state.lastCycleTs >= s.heartbeat.intervalMin * 60000;
            if (!info.rec) {
                const base = await this.runCycle({ manual: false }); // sets the baseline (no model call)
                if (!initiativeOn || base.status !== 'skipped') return base;
                reason = base.reason;
            } else if (info.fresh.length >= s.heartbeat.minNewMessages) {
                if (!quiet) reason = 'waiting-for-quiet';
                else if (!intervalOk) reason = 'interval';
                else return this.runCycle({ manual: false });
            } else {
                reason = `not-enough-new-messages (${info.fresh.length}/${s.heartbeat.minNewMessages})`;
            }
        }
        if (initiativeOn) {
            const r = await this.maybeIdle(snap, cs, data, s, t);
            if (r) return r;
        }
        return this.skip(reason);
    }

    async callTask(task, prompt, maxTokens, signal) {
        const { getSettings, saveSettings, callModel, now } = this.deps;
        const s = getSettings();
        const verdict = checkBudget(s.usage, s.limits, now());
        if (!verdict.ok) throw new BudgetError(verdict.reason);
        const profile = getProfileForTask(s, task);
        const inTok = estimateTokens(prompt.system + prompt.user);
        let text = '';
        try {
            const res = await callModel(profile, { system: prompt.system, user: prompt.user, maxTokens, signal });
            text = String(res?.text ?? '');
            return text;
        } finally {
            // Failed calls still count as calls, so retry storms stay bounded.
            recordUsage(s.usage, now(), inTok, estimateTokens(text));
            saveSettings();
        }
    }

    baseContext(data, snap, s, transcript, t, freshMsgs = null) {
        const recent = data.diary.slice(-3);
        return {
            charName: snap.charName,
            userName: snap.userName,
            card: s.privacy.sendCharacterCard ? snap.card : null,
            cardChars: s.privacy.cardChars,
            mood: data.state.mood,
            workingNote: data.state.workingNote,
            lastDiaryTs: data.state.lastDiaryTs,
            recentDiary: recent,
            revisitCandidates: [...recent, ...relevantDiary(data, transcript, { limit: 3, excludeIds: recent.map(e => e.id), now: t })],
            unsaid: heldUnsaid(data),
            gaps: freshMsgs && s.awareness.timeGaps ? findGaps(freshMsgs, s.awareness.gapMinHours * 3600000) : [],
            memories: retrieveMemories(data, transcript + ' ' + data.state.workingNote, { limit: 6, maxChars: 900, now: t }),
            goals: data.goals.filter(isOpen),
            closedGoals: getRecentlyClosed(data, t).slice(-6),
            transcript,
            now: t,
        };
    }

    // ------------------------------------------------------------------ cycle (after new messages)

    async runCycle({ manual = false } = {}) {
        const { getSettings, getSnapshot, loadChar, saveChar, now, onUpdate } = this.deps;
        if (this.running) return this.skip('busy');
        const s = getSettings();
        const snap = getSnapshot();
        if (!snap) return this.skip('no-chat');
        if (!s.enabled) return this.skip('disabled');
        const cs = getCharSettings(s, snap.avatar);
        if (!cs.enabled) return this.skip('character-disabled');
        if (!cycleEnabled(cs)) return this.skip('nothing-enabled');

        this.running = true;
        const ctrl = new AbortController();
        this.abort = ctrl;
        onUpdate();
        const redactErr = (e) => this.deps.redact(String(e?.message || e));
        try {
            const data = await loadChar(snap.avatar, snap.charName);
            const t0 = now();
            const { rec, lastIdx, fresh } = this.pending(data, snap, s);

            if (!rec && !manual) {
                // First sight of this chat: set a baseline instead of paying to digest old history.
                data.state.processed[snap.chatId] = { idx: lastIdx + 1, ts: t0 };
                pushLog(data, { kind: 'baseline', summary: `Начальная точка чата: сообщение ${lastIdx + 1}` }, t0);
                saveChar(data);
                return this.skip('baseline-set');
            }
            if (!manual && fresh.length < s.heartbeat.minNewMessages) return this.skip(`not-enough-new-messages (${fresh.length}/${s.heartbeat.minNewMessages})`);
            if (fresh.length === 0) return this.skip('no-new-messages');

            const transcript = formatTranscript(fresh);
            const baseCtx = this.baseContext(data, snap, s, transcript, t0, fresh);

            // 1) Decision. A model call, but with a tiny output.
            const raw = await this.callTask('heartbeat', buildHeartbeatPrompt(baseCtx), 300, ctrl.signal);
            const decision = normalizeHeartbeatResult(parseJsonLoose(raw));
            if (!decision) throw new Error('Модель heartbeat вернула нечитаемый ответ');

            // 2) Actions, each on its own configured model.
            let diaryRes = null, memRes = null, goalOps = null;
            const diaryGapOk = manual || (t0 - data.state.lastDiaryTs) >= s.heartbeat.diaryMinGapMin * 60000;
            const attempt = async (kind, task, prompt, parse) => {
                try {
                    const out = await this.callTask(task, prompt, s.heartbeat.maxOutputTokens, ctrl.signal);
                    const res = parse(out);
                    if (!res) pushLog(data, { kind, summary: `Модель (${kind}) вернула нечитаемый ответ`, ok: false }, now());
                    return res;
                } catch (e) {
                    if (e.name === 'AbortError' || e.name === 'BudgetError') throw e;
                    pushLog(data, { kind, summary: `Ошибка (${kind}): ${redactErr(e)}`, ok: false }, now());
                    return null;
                }
            };
            const revisitEntry = decision.revisitId ? baseCtx.revisitCandidates.find(e => e.id === decision.revisitId) || null : null;
            // A valid revisit implies a diary entry; an unknown id from the model implies nothing.
            if (cs.diary && (decision.diary || revisitEntry) && diaryGapOk) {
                diaryRes = await attempt('diary', 'diary', buildDiaryPrompt(baseCtx, decision.diaryFocus, revisitEntry), (out) => normalizeDiaryResult(parseJsonLoose(out), out));
            }
            if (cs.memory && decision.remember) {
                memRes = await attempt('memory', 'memory', buildMemoryPrompt(baseCtx, s.memory.maxPerCycle), (out) => normalizeMemoryResult(parseJsonLoose(out), s.memory.maxPerCycle));
            }
            if (cs.goals && decision.goals) {
                goalOps = await attempt('goals', 'goals', buildGoalsPrompt(baseCtx, 3), (out) => normalizeGoalOps(parseJsonLoose(out)));
            }

            // 3) The chat may have changed while we were waiting: never write results into the wrong place.
            const snap2 = getSnapshot();
            if (!snap2 || snap2.chatId !== snap.chatId || snap2.avatar !== snap.avatar) {
                pushLog(data, { kind: 'cycle', summary: 'Результат отброшен: чат сменился во время цикла', ok: false }, now());
                return this.skip('discarded-chat-changed');
            }

            // 4) Apply results.
            const t1 = now();
            let diaryAdded = 0, memAdded = 0, memMerged = 0, memUpdated = 0, revisited = 0, unsaidAdded = 0, unsaidResolvedN = 0, unsaidFaded = 0;
            if (diaryRes) {
                const e = addDiaryEntry(data, { ...diaryRes, chatId: snap.chatId, source: manual ? 'manual-run' : 'heartbeat', revisit: revisitEntry ? { of: revisitEntry.id, stance: diaryRes.stance } : null }, t1);
                if (e) { diaryAdded = 1; if (e.revisit) revisited = 1; }
            }
            for (const m of memRes || []) {
                if (m.updates) {
                    const target = data.memories.find(x => x.id === m.updates && x.status === 'active');
                    if (target && !target.userEdited && !target.pinned) {
                        updateMemory(data, target.id, { text: m.text, confidence: m.confidence, importance: m.importance, type: m.type }, t1, { by: 'model', reason: 'model-correction' });
                        memUpdated++;
                        continue;
                    }
                    if (target) { pushLog(data, { kind: 'memory', summary: 'Модель предложила изменить закреплённое/отредактированное вами воспоминание — пропущено' }, t1); continue; }
                }
                const r = addMemory(data, { ...m, chatId: snap.chatId, from: 'heartbeat' }, t1, { similarityThreshold: s.memory.similarityThreshold });
                if (r.action === 'added') memAdded++; else if (r.action === 'merged') memMerged++;
            }
            const archived = enforceMemoryLimit(data, s.memory.maxActive, t1);

            let goalRes = null, goalsExpired = 0;
            if (cs.goals) {
                if (goalOps) goalRes = applyGoalOps(data, goalOps, t1, { maxActive: s.goals.maxActive, maxNewPerDay: s.goals.maxNewPerDay, chatId: snap.chatId });
                goalsExpired = expireStaleGoals(data, t1, s.goals.staleDays);
                pruneClosedGoals(data);
                if (goalRes?.skipped.length) pushLog(data, { kind: 'goals', summary: `Операции с целями отклонены: ${[...new Set(goalRes.skipped)].join(', ')}` }, t1);
            }

            if (cs.unsaid) {
                unsaidResolvedN = resolveUnsaid(data, decision.unsaidResolved, t1, 'voiced', 'said or made moot in the conversation');
                if (decision.unsaid) {
                    const r = addUnsaid(data, { ...decision.unsaid, chatId: snap.chatId }, t1, { maxHeld: s.unsaid.maxHeld });
                    if (r.action === 'added') unsaidAdded = 1;
                }
                unsaidFaded = expireUnsaid(data, t1, s.unsaid.expireDays);
                pruneUnsaid(data);
            }

            data.state.mood = decision.mood || data.state.mood;
            data.state.workingNote = decision.workingNote;
            data.state.lastCycleTs = t1;
            data.state.processed[snap.chatId] = { idx: fresh[fresh.length - 1].idx + 1, ts: t1 };
            const goalPart = goalRes ? [
                goalRes.created && `цели +${goalRes.created}`, goalRes.completed && `достигнуто ${goalRes.completed}`,
                goalRes.dropped && `отменено ${goalRes.dropped}`, goalRes.updated && `обновлено ${goalRes.updated}`,
            ].filter(Boolean).join(', ') : '';
            const summary = `${manual ? 'Ручной запуск: ' : ''}дневник +${diaryAdded}, память +${memAdded}`
                + (memMerged ? `, объединено ${memMerged}` : '') + (memUpdated ? `, исправлено ${memUpdated}` : '') + (archived ? `, в архив ${archived}` : '')
                + (goalPart ? `, ${goalPart}` : '') + (goalsExpired ? `, устарело целей ${goalsExpired}` : '')
                + (revisited ? ', вернулся к прошлой записи' : '') + (unsaidAdded ? ', осталось недосказанное' : '')
                + (unsaidResolvedN ? `, высказано ${unsaidResolvedN}` : '') + (unsaidFaded ? `, забылось ${unsaidFaded}` : '')
                + (!diaryAdded && !memAdded && !memMerged && !memUpdated && !goalPart && !goalsExpired && !unsaidAdded && !unsaidResolvedN && !unsaidFaded ? ' (ничего значимого)' : '');
            pushLog(data, { kind: 'cycle', summary }, t1);
            saveChar(data);

            this.failures = 0;
            this.lastError = '';
            this.lastResult = { ts: t1, summary };
            this.lastSkip = '';
            return { status: 'ok', diaryAdded, memAdded, memMerged, memUpdated, goals: goalRes, summary };
        } catch (e) {
            return await this.handleError(e, snap);
        } finally {
            this.running = false;
            this.abort = null;
            onUpdate();
        }
    }

    // ------------------------------------------------------------------ initiative (during silence)

    gateContext(snap, s, data, t) {
        return {
            init: s.initiative, st: data.state.initiative, now: t, messages: snap.messages,
            lastActivityAt: this.lastActivityAt(snap), composing: snap.composing, generating: snap.generating,
        };
    }

    /** Free gates first; only then the (cheap) model decision. Returns null when nothing should happen. */
    async maybeIdle(snap, cs, data, s, t) {
        const gate = canReachOut(this.gateContext(snap, s, data, t));
        if (!gate.ok) { this.lastInitiative = gate.reason; return null; }
        const due = idleCheckDue({ init: s.initiative, st: data.state.initiative, now: t });
        if (!due.ok) { this.lastInitiative = due.reason; return null; }
        if (getActiveGoals(data).length === 0 && !data.state.workingNote && heldUnsaid(data).length === 0) { this.lastInitiative = 'no-reason-to-write'; return null; }
        return this.runInitiative({ manual: false });
    }

    /** manual = true: ignores timing limits and skips the model's decision (used by the "test" button). */
    async runInitiative({ manual = false } = {}) {
        const { getSettings, getSnapshot, loadChar, saveChar, now, onUpdate, sendMessage } = this.deps;
        if (this.running) return this.skip('busy');
        const s = getSettings();
        const snap = getSnapshot();
        if (!snap) return this.skip('no-chat');
        if (!s.enabled) return this.skip('disabled');
        const cs = getCharSettings(s, snap.avatar);
        if (!cs.enabled || !cs.initiative) return this.skip('initiative-off');
        if (s.initiative.mode === 'off') return this.skip('initiative-off');

        this.running = true;
        const ctrl = new AbortController();
        this.abort = ctrl;
        onUpdate();
        try {
            const data = await loadChar(snap.avatar, snap.charName);
            const t0 = now();
            const gate = canReachOut(this.gateContext(snap, s, data, t0), { ignoreTiming: manual });
            if (!gate.ok) { this.lastInitiative = gate.reason; return this.skip(`initiative: ${gate.reason}`); }
            const st = data.state.initiative;
            recordIdleCheck(st, t0); // counted even if the call fails, so costs stay bounded
            saveChar(data);

            const transcript = formatTranscript(snap.messages.slice(-12), { maxChars: 4000 });
            const lastAt = this.lastActivityAt(snap);
            const ctx = { ...this.baseContext(data, snap, s, transcript, t0), silenceMs: lastAt ? t0 - lastAt : 0, lastSentTs: st.lastSentTs };

            let reason = 'manual test', topic = '', goalId = null, unsaidItem = null;
            if (!manual) {
                const raw = await this.callTask('heartbeat', buildIdlePrompt(ctx), 250, ctrl.signal);
                const d = normalizeIdleResult(parseJsonLoose(raw));
                if (!d) throw new Error('Модель heartbeat вернула нечитаемый ответ (проверка инициативы)');
                if (!d.reachOut) {
                    this.lastInitiative = 'model-decided-not-to-write';
                    pushLog(data, { kind: 'initiative', summary: 'Проверка инициативы: персонаж решил пока не писать' }, now());
                    saveChar(data);
                    return { status: 'ok', sent: false, summary: 'Персонаж решил пока не писать' };
                }
                ({ reason, topic, goalId } = d);
                unsaidItem = d.unsaidId ? heldUnsaid(data).find(u => u.id === d.unsaidId) || null : null;
                if (unsaidItem && !topic) topic = unsaidItem.text;
            }

            const raw2 = await this.callTask('initiative', buildComposePrompt(ctx, { reason, topic }), Math.min(400, s.heartbeat.maxOutputTokens), ctrl.signal);
            const text = cleanInitiativeText(raw2, snap.charName);
            if (text.length < 2) throw new Error('Модель вернула пустое сообщение');

            // Re-check everything right before sending: the user may have replied, typed, or switched chats.
            const snap2 = getSnapshot();
            const t1 = now();
            if (!snap2 || snap2.chatId !== snap.chatId || snap2.avatar !== snap.avatar) {
                pushLog(data, { kind: 'initiative', summary: 'Сообщение не отправлено: чат сменился', ok: false }, t1);
                saveChar(data);
                return this.skip('discarded-chat-changed');
            }
            const newUserMessage = snap2.messages.length > snap.messages.length && snap2.messages.slice(snap.messages.length).some(m => m.is_user);
            const gate2 = canReachOut(this.gateContext(snap2, s, data, t1), { ignoreTiming: manual });
            if (newUserMessage || !gate2.ok) {
                const why = newUserMessage ? 'user-replied' : gate2.reason;
                this.lastInitiative = why;
                pushLog(data, { kind: 'initiative', summary: `Сообщение не отправлено: ${why}`, ok: false }, t1);
                saveChar(data);
                return this.skip(`initiative: ${why}`);
            }

            await sendMessage({ snap: snap2, text, reason });
            recordInitiativeSent(st, now());
            if (goalId) noteGoalProgress(data, goalId, 'Персонаж написал первым на эту тему', t1);
            if (unsaidItem) resolveUnsaid(data, [unsaidItem.id], t1, 'voiced', 'said on the character\'s own initiative');
            const summary = `Написал(а) первым${reason && !manual ? `: ${reason}` : manual ? ' (ручной тест)' : ''}`;
            pushLog(data, { kind: 'initiative', summary }, t1);
            saveChar(data);
            this.failures = 0;
            this.lastError = '';
            this.lastInitiative = 'sent';
            this.lastResult = { ts: t1, summary };
            return { status: 'ok', sent: true, summary };
        } catch (e) {
            return await this.handleError(e, snap);
        } finally {
            this.running = false;
            this.abort = null;
            onUpdate();
        }
    }

    async handleError(e, snap) {
        const { now, loadChar, saveChar, getSettings, saveSettings, notify } = this.deps;
        const msg = this.deps.redact(String(e?.message || e));
        if (e?.name === 'AbortError') return this.skip('aborted');
        if (e?.name === 'BudgetError') {
            this.lastSkip = msg;
            try {
                const data = await loadChar(snap.avatar, snap.charName);
                pushLog(data, { kind: 'budget', summary: msg, ok: false }, now());
                saveChar(data);
            } catch { /* logging is best effort */ }
            return { status: 'skipped', reason: msg };
        }
        this.failures += 1;
        this.lastError = msg;
        this.backoffUntil = now() + Math.min(3600000, 60000 * 2 ** this.failures);
        try {
            const data = await loadChar(snap.avatar, snap.charName);
            pushLog(data, { kind: 'error', summary: msg, ok: false }, now());
            saveChar(data);
        } catch { /* best effort */ }
        if (this.failures >= MAX_FAILURES_BEFORE_PAUSE) {
            getSettings().heartbeat.paused = true;
            saveSettings();
            notify('error', `Inner Life: фоновая активность приостановлена после ${this.failures} ошибок подряд. Последняя: ${msg}`);
        }
        return { status: 'error', error: msg };
    }

    resume() {
        const s = this.deps.getSettings();
        s.heartbeat.paused = false;
        this.failures = 0;
        this.backoffUntil = 0;
        this.lastError = '';
        this.deps.saveSettings();
        this.deps.onUpdate();
    }
}
