export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const icon = (name, className = '') => {
  const id = String(name || 'file').startsWith('i-') ? String(name) : `i-${name}`;
  return `<svg class="icon${className ? ` ${className}` : ''}" aria-hidden="true"><use href="#${id}"></use></svg>`;
};

export function debounce(fn, wait = 200) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

export function throttleRaf(fn) {
  let frame = 0;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn(...lastArgs);
    });
  };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function onDelegated(root, eventName, selector, handler) {
  root.addEventListener(eventName, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

export function openDialog(dialog) {
  const el = typeof dialog === 'string' ? $(dialog) : dialog;
  if (!el) return;
  if (!el.open) el.showModal();
  requestAnimationFrame(() => {
    const target = el.querySelector('[data-autofocus]') || el.querySelector('.modal-head-copy h2');
    if (target) {
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  });
  return el;
}

export function closeDialog(dialog) {
  const el = typeof dialog === 'string' ? $(dialog) : dialog;
  if (el?.open) el.close();
}

export function setBusyButton(button, busy, label = 'Processando…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="search-spinner"></span> ${label}`;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}
