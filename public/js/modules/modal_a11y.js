/**
 * CoreFeed v3.0 — 弹窗焦点陷阱与焦点恢复无障碍控制器 (public/js/modules/modal_a11y.js)
 */

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

function getVisibleFocusableElements(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
        if (el.closest('.hidden') || el.hasAttribute('hidden')) return false;
        const style = typeof window !== 'undefined' && window.getComputedStyle
            ? window.getComputedStyle(el)
            : null;
        return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });
}

export class ModalFocusController {
    constructor() {
        this._records = new WeakMap();
    }

    activate(modalEl, initialFocusSelector = '') {
        if (!modalEl) return;
        const existing = this._records.get(modalEl);
        if (existing) {
            this._cleanupListener(modalEl, existing);
        }

        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const handleKeydown = (event) => {
            if (event.key !== 'Tab' || modalEl.classList.contains('hidden')) return;
            const focusables = getVisibleFocusableElements(modalEl);
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;

            if (event.shiftKey) {
                if (active === first || !modalEl.contains(active)) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (active === last || !modalEl.contains(active)) {
                event.preventDefault();
                first.focus();
            }
        };

        modalEl.addEventListener('keydown', handleKeydown);
        this._records.set(modalEl, { previousFocus, handleKeydown });

        requestAnimationFrame(() => {
            if (modalEl.classList.contains('hidden')) return;
            const preferred = initialFocusSelector ? modalEl.querySelector(initialFocusSelector) : null;
            const target = (preferred && !preferred.disabled && !preferred.closest('.hidden'))
                ? preferred
                : getVisibleFocusableElements(modalEl)[0];
            if (target && typeof target.focus === 'function') {
                target.focus({ preventScroll: true });
            }
        });
    }

    deactivate(modalEl) {
        if (!modalEl) return;
        const record = this._records.get(modalEl);
        if (!record) return;
        this._cleanupListener(modalEl, record);
        this._records.delete(modalEl);

        const prev = record.previousFocus;
        if (prev && document.contains(prev) && typeof prev.focus === 'function') {
            try {
                prev.focus({ preventScroll: true });
            } catch (_) {}
        }
    }

    _cleanupListener(modalEl, record) {
        if (record && record.handleKeydown) {
            modalEl.removeEventListener('keydown', record.handleKeydown);
        }
    }
}
