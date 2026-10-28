// Inner Life: diary, memory and a heartbeat for SillyTavern characters.
// Entry point: wires settings, engine, events, prompt injection and UI together.
import { HeartbeatEngine } from './heartbeat.js';
import { currentCharacter, ctx, getSnapshot, insertCharacterMessage, markGenerating, toast } from './host.js';
import { clearInjection, computeInjection, installInterceptor } from './injector.js';
import { callModel, collectSecrets } from './llm.js';
import { getCharSettings, mergeSettings } from './settings.js';
import { deleteCharData, exportJson, flushAll, loadChar, saveChar } from './storage.js';
import { openPanel, refreshPanel } from './ui.js';
import { redactSecrets } from './util.js';

const SETTINGS_KEY = 'inner-life'; // key inside extension_settings; independent of the folder name
const BASE_URL = new URL('./', import.meta.url).href; // so the extension works whatever the folder is called

jQuery(async () => {
    const log = (...a) => console.log('[inner-life]', ...a);
    log('Loading...');
    try {
        const c = ctx();
        c.extensionSettings[SETTINGS_KEY] = mergeSettings(c.extensionSettings[SETTINGS_KEY]);
        const getSettings = () => ctx().extensionSettings[SETTINGS_KEY];
        const saveSettings = () => ctx().saveSettingsDebounced();

        const engine = new HeartbeatEngine({
            now: () => Date.now(),
            getSettings,
            saveSettings,
            getSnapshot,
            loadChar,
            saveChar,
            callModel,
            sendMessage: async ({ snap, text, reason }) => {
                await insertCharacterMessage({ charName: snap.charName, text, reason });
                toast('info', `${snap.charName} написал(а) вам первым`);
            },
            onUpdate: () => { updateDrawer(); refreshPanel(); },
            notify: (level, msg) => toast(level, msg),
            redact: (t) => redactSecrets(t, collectSecrets(getSettings())),
        });

        const app = {
            getSettings, saveSettings, engine, currentCharacter, loadChar, saveChar, deleteCharData, exportJson,
            computeInjection: () => computeInjection(getSettings()),
            onChange: () => updateDrawer(),
        };

        // ----- settings drawer -----
        const html = await $.get(`${BASE_URL}settings.html`);
        $('#extensions_settings2').append(html);

        function updateDrawer() {
            const s = getSettings();
            const cur = currentCharacter();
            $('#il_master').prop('checked', s.enabled);
            const charBox = $('#il_char');
            if (cur) {
                charBox.prop('disabled', false).prop('checked', getCharSettings(s, cur.avatar).enabled);
                $('#il_char_label').text(`Включить для «${cur.name}»`);
            } else {
                charBox.prop('disabled', true).prop('checked', false);
                $('#il_char_label').text('Включить для текущего персонажа (откройте чат с одним персонажем)');
            }
            const st = engine.getStatus();
            $('#il_status').text(!s.enabled ? 'Выключено.' : st.running ? 'Идёт внутренний цикл…' : st.paused ? 'Фон приостановлен (см. панель).' : st.lastError ? `Ошибка: ${st.lastError}` : 'Активно.');
        }

        $('#il_master').on('input', (e) => {
            getSettings().enabled = Boolean($(e.target).prop('checked'));
            saveSettings();
            if (!getSettings().enabled) clearInjection();
            updateDrawer();
        });
        $('#il_char').on('input', async (e) => {
            const cur = currentCharacter();
            if (!cur) return;
            const on = Boolean($(e.target).prop('checked'));
            getCharSettings(getSettings(), cur.avatar).enabled = on;
            if (on && !getSettings().enabled) {
                getSettings().enabled = true;
                toast('info', 'Общий переключатель Inner Life тоже включён.');
            }
            saveSettings();
            if (on) await ensureLoaded();
            updateDrawer();
        });
        $('#il_open').on('click', () => openPanel(app));

        // ----- chat/generation lifecycle -----
        async function ensureLoaded() {
            const cur = currentCharacter();
            if (!cur) return;
            try { await loadChar(cur.avatar, cur.name); } catch (e) { toast('error', String(e.message || e), 'Inner Life: данные персонажа'); }
        }

        const { eventSource, event_types } = c;
        eventSource.on(event_types.MESSAGE_RECEIVED, () => engine.notifyMessage());
        eventSource.on(event_types.MESSAGE_SENT, () => engine.notifyMessage());
        eventSource.on(event_types.CHAT_CHANGED, async () => {
            engine.notifyChatChanged();
            clearInjection();
            markGenerating(false);
            await ensureLoaded();
            updateDrawer();
        });
        eventSource.on(event_types.GENERATION_STARTED, (_type, _params, dryRun) => { if (!dryRun) markGenerating(true); });
        eventSource.on(event_types.GENERATION_ENDED, () => markGenerating(false));
        eventSource.on(event_types.GENERATION_STOPPED, () => markGenerating(false));

        // Persist pending changes when the tab is hidden or closed.
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
        window.addEventListener('pagehide', () => { flushAll(); });

        installInterceptor(getSettings);
        await ensureLoaded();
        updateDrawer();
        engine.start();
        log('✅ Loaded successfully');
    } catch (error) {
        console.error('[inner-life] ❌ Failed to load:', error);
        toast('error', `Не удалось загрузить расширение: ${error?.message || error}`);
    }
});
