// Calls a configured model profile. Three kinds:
//  - current:    the main API selected in SillyTavern (generateRaw)
//  - st-profile: a Connection Manager profile (ConnectionManagerRequestService)
//  - openai:     any OpenAI-compatible endpoint (own proxy / local server); routed through the SillyTavern server,
//                so browser CORS rules do not apply and the key never goes to the page of a third party.
import { ctx } from './host.js';
import { redactSecrets } from './util.js';

const sessionKeys = new Map(); // profileId -> key, for profiles with persistKey === false

export function setSessionKey(profileId, key) { if (key) sessionKeys.set(profileId, key); else sessionKeys.delete(profileId); }
export function getKey(profile) { return profile.persistKey ? (profile.apiKey || '') : (sessionKeys.get(profile.id) || ''); }
export function hasKey(profile) { return !!getKey(profile); }

export function collectSecrets(settings) {
    const out = [];
    for (const p of settings.models.profiles) {
        if (p.apiKey) out.push(p.apiKey);
        const sk = sessionKeys.get(p.id);
        if (sk) out.push(sk);
    }
    return out;
}

export function normalizeBaseUrl(url) {
    let u = String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) return '';
    return u;
}

function makeSignal(external, ms) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onExternal = () => ctrl.abort();
    if (external) {
        if (external.aborted) ctrl.abort(); else external.addEventListener('abort', onExternal, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
    return {
        signal: ctrl.signal,
        wasTimeout: () => timedOut,
        done: () => { clearTimeout(timer); external?.removeEventListener?.('abort', onExternal); },
    };
}

async function callOnce(profile, { system, user, maxTokens, signal }) {
    const c = ctx();
    const temperature = Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 0.7;
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

    if (profile.type === 'current') {
        const text = await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens, trimNames: false });
        return String(text ?? '');
    }

    if (profile.type === 'st-profile') {
        const S = c.ConnectionManagerRequestService;
        if (!S) throw new Error('Connection Manager недоступен в этой версии SillyTavern');
        if (!profile.stProfileId) throw new Error('Не выбран профиль Connection Manager');
        const prof = S.getProfile(profile.stProfileId);
        const api = S.validateProfile(prof);
        const prompt = api.selected === 'textgenerationwebui' ? S.constructPrompt(messages, prof.id) : messages;
        const res = await S.sendRequest(prof.id, prompt, maxTokens, { stream: false, signal, extractData: true }, { temperature });
        return String(res?.content ?? '');
    }

    if (profile.type === 'openai') {
        const base = normalizeBaseUrl(profile.baseUrl);
        if (!base) throw new Error('Некорректный Base URL (нужен http(s)://…/v1)');
        if (!profile.model) throw new Error('Не указано название модели');
        const res = await c.ChatCompletionService.processRequest({
            stream: false,
            messages,
            model: profile.model,
            chat_completion_source: 'openai',
            max_tokens: maxTokens,
            temperature,
            reverse_proxy: base,
            proxy_password: getKey(profile),
        }, {}, true, signal);
        return String(res?.content ?? '');
    }

    throw new Error(`Неизвестный тип профиля: ${profile.type}`);
}

/** @returns {Promise<{text: string}>} */
export async function callModel(profile, { system, user, maxTokens = 500, signal = null }) {
    const attempts = 1 + Math.max(0, Math.min(3, Number(profile.retries) || 0));
    const timeoutMs = Math.max(5, Number(profile.timeoutSec) || 60) * 1000;
    const limit = Math.min(Number(profile.maxTokens) || maxTokens, Math.max(maxTokens, 50));
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const sig = makeSignal(signal, timeoutMs);
        try {
            const text = await callOnce(profile, { system, user, maxTokens: limit, signal: sig.signal });
            if (!text.trim()) throw new Error('Пустой ответ модели');
            return { text };
        } catch (e) {
            if (sig.wasTimeout()) lastErr = new Error(`Таймаут запроса (${Math.round(timeoutMs / 1000)} с)`);
            else if (signal?.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
            else lastErr = e?.cause?.message ? new Error(`${e.message}: ${e.cause.message}`) : e;
            const msg = String(lastErr?.message || '');
            if (/\b(400|401|403|404)\b|invalid|unauthor|forbidden|Base URL|модел/i.test(msg)) break; // retrying will not help
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        } finally {
            sig.done();
        }
    }
    throw lastErr;
}

/** Connection test used by the UI. Never throws; secrets are redacted from the error text. */
export async function testProfile(profile, secrets = []) {
    const t0 = Date.now();
    try {
        const { text } = await callModel({ ...profile, retries: 0 }, {
            system: 'You are a connection test. Reply with exactly one word.',
            user: 'Reply with the single word: OK',
            maxTokens: 32,
        });
        return { ok: true, ms: Date.now() - t0, text: text.trim().slice(0, 80) };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: redactSecrets(String(e?.message || e), [...secrets, getKey(profile)]) };
    }
}
