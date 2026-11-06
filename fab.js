// Floating round button (heart icon) that opens the Inner Life panel from anywhere.
// Draggable (position is remembered), keyboard-accessible, with a small status dot.
// Position maths is exported as pure functions so it can be unit-tested.

export const FAB_SIZE = 44;
const MARGIN = 6;
const DEFAULT_RIGHT = 14;
const DEFAULT_BOTTOM = 120; // clears the message box on phones
const DRAG_THRESHOLD = 6;

/** Keeps the button fully on screen. */
export function clampPosition(pos, viewport, size = FAB_SIZE, margin = MARGIN) {
    const maxX = Math.max(margin, viewport.w - size - margin);
    const maxY = Math.max(margin, viewport.h - size - margin);
    return {
        x: Math.min(maxX, Math.max(margin, Number(pos.x) || 0)),
        y: Math.min(maxY, Math.max(margin, Number(pos.y) || 0)),
    };
}

export function defaultPosition(viewport, size = FAB_SIZE) {
    return clampPosition({ x: viewport.w - size - DEFAULT_RIGHT, y: viewport.h - size - DEFAULT_BOTTOM }, viewport, size);
}

/** A press that moved less than the threshold is a tap, not a drag. */
export function exceedsDragThreshold(dx, dy, threshold = DRAG_THRESHOLD) {
    return Math.hypot(dx, dy) > threshold;
}

export function isValidPosition(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * options = { getSettings, saveSettings, onOpen, doc?, win? }
 * Settings used: ui.floatingButton (boolean), ui.fabPos ({x, y} | null).
 */
export function createFab({ getSettings, saveSettings, onOpen, doc = document, win = window }) {
    const el = doc.createElement('div');
    el.id = 'il_floating_button'; // NOT il_fab: that id belongs to the checkbox in settings.html
    el.className = 'il-fab il-fab-off';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('title', 'Inner Life: дневник, память, цели');
    el.setAttribute('aria-label', 'Открыть Inner Life');
    const icon = doc.createElement('i');
    icon.className = 'fa-solid fa-heart';
    el.append(icon);

    let drag = null;
    let justDragged = false;

    const viewport = () => ({ w: win.innerWidth || 360, h: win.innerHeight || 640 });
    const currentPosition = () => {
        const saved = getSettings().ui.fabPos;
        return isValidPosition(saved) ? clampPosition(saved, viewport()) : defaultPosition(viewport());
    };
    const place = (p) => { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; };

    function applyPosition() {
        if (drag?.moved) return; // a status refresh must not yank the button out from under the finger
        place(currentPosition());
    }

    function setVisible(visible) { el.style.display = visible ? '' : 'none'; }

    /** state: 'on' (working for this character) | 'off' | 'warn' (paused / error) | 'busy' (thinking right now) */
    function setState(state) {
        for (const s of ['on', 'off', 'warn', 'busy']) el.classList.toggle(`il-fab-${s}`, s === state);
    }

    el.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        drag = { startX: e.clientX, startY: e.clientY, origin: currentPosition(), moved: false, id: e.pointerId };
        try { el.setPointerCapture?.(e.pointerId); } catch { /* not supported: dragging still works while the pointer stays over the button */ }
    });

    el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
        if (!drag.moved) {
            if (!exceedsDragThreshold(dx, dy)) return;
            drag.moved = true;
            el.classList.add('il-fab-dragging');
        }
        place(clampPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, viewport()));
    });

    const finish = (cancelled) => {
        if (!drag) return;
        const moved = drag.moved;
        try { el.releasePointerCapture?.(drag.id); } catch { /* ignore */ }
        drag = null;
        el.classList.remove('il-fab-dragging');
        if (!moved) return;
        justDragged = true; // swallow the click that follows a drag
        setTimeout(() => { justDragged = false; }, 0);
        if (cancelled) { applyPosition(); return; }
        const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
        getSettings().ui.fabPos = clampPosition({ x: left, y: top }, viewport());
        saveSettings();
    };
    el.addEventListener('pointerup', () => finish(false));
    el.addEventListener('pointercancel', () => finish(true));

    el.addEventListener('click', () => {
        if (justDragged) return;
        onOpen();
    });
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
    });

    const onResize = () => applyPosition();
    win.addEventListener('resize', onResize);

    doc.body.append(el);
    applyPosition();
    setVisible(!!getSettings().ui.floatingButton);

    return {
        element: el,
        setVisible,
        setState,
        applyPosition,
        destroy() { win.removeEventListener('resize', onResize); el.remove(); },
    };
}
