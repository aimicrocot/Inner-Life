// Per-character persistence through SillyTavern's user-files API (data/<user>/user/files/inner-life-<key>.json).
// Why: it is server-side (survives browser changes), portable (plain JSON files in the user's data folder),
// and does not bloat settings.json the way storing everything in extension_settings would.
import { ctx } from './host.js';
import { emptyCharData, migrateCharData } from './store.js';
import { fileNameForCharacter, toBase64Utf8 } from './util.js';

const cache = new Map(); // avatar -> { data, file, timer, chain, dirty }
const SAVE_DEBOUNCE_MS = 1000;

export function getCached(avatar) { return cache.get(avatar)?.data || null; }

async function readFile(file) {
    const res = await fetch(`/user/files/${file}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Не удалось прочитать ${file}: HTTP ${res.status}`);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        // Never overwrite a file we cannot parse: that would destroy the user's data.
        throw new Error(`Файл ${file} повреждён (невалидный JSON). Исправьте или удалите его вручную в папке user/files.`);
    }
}

export async function loadChar(avatar, name) {
    const hit = cache.get(avatar);
    if (hit) { hit.data.name = name || hit.data.name; return hit.data; }
    const file = fileNameForCharacter(avatar);
    const raw = await readFile(file);
    const data = raw ? migrateCharData(raw, avatar, name) : emptyCharData(avatar, name);
    // Another call may have loaded it while we awaited.
    const again = cache.get(avatar);
    if (again) return again.data;
    cache.set(avatar, { data, file, timer: null, chain: Promise.resolve(), dirty: false });
    return data;
}

async function writeNow(entry) {
    const body = JSON.stringify(entry.data);
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name: entry.file, data: toBase64Utf8(body) }),
    });
    if (!res.ok) throw new Error(`Не удалось сохранить ${entry.file}: HTTP ${res.status}`);
}

function flushEntry(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (!entry.dirty) return entry.chain;
    entry.dirty = false;
    entry.chain = entry.chain.then(() => writeNow(entry)).catch(e => {
        entry.dirty = true;
        console.error('[inner-life] save failed', e);
        globalThis.toastr?.error(String(e.message || e), 'Inner Life: ошибка сохранения');
    });
    return entry.chain;
}

/** Debounced save; safe to call often. */
export function saveChar(data) {
    const entry = cache.get(data.avatar);
    if (!entry) return;
    data.updatedAt = Date.now();
    entry.dirty = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushEntry(entry), SAVE_DEBOUNCE_MS);
}

export function flushAll() {
    return Promise.all([...cache.values()].map(flushEntry));
}

export async function deleteCharData(avatar) {
    const entry = cache.get(avatar);
    const file = entry?.file || fileNameForCharacter(avatar);
    if (entry?.timer) clearTimeout(entry.timer);
    cache.delete(avatar);
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ path: `user/files/${file}` }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Не удалось удалить ${file}: HTTP ${res.status}`);
}

export function exportJson(data) {
    return JSON.stringify(data, null, 2);
}
