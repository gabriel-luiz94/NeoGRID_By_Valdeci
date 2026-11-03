import { $ } from '../core/dom.js';
import { esc } from '../core/format.js';

const ICONS = {
  success: 'i-check',
  error: 'i-alert',
  warning: 'i-alert',
  info: 'i-info',
};

let sequence = 0;

function dismiss(element) {
  if (!element || element.classList.contains('is-leaving')) return;
  element.classList.add('is-leaving');
  setTimeout(() => element.remove(), 220);
}

export function toast(title, message = '', options = {}) {
  const stack = $('#toasts');
  if (!stack) return { dismiss() {} };
  const type = ['success', 'error', 'warning', 'info'].includes(options.type) ? options.type : 'info';
  const duration = options.duration ?? (type === 'error' ? 6500 : 4400);
  const id = `toast-${++sequence}`;

  const element = document.createElement('div');
  element.className = `toast toast-${type}`;
  element.dataset.toastId = id;
  element.innerHTML = `
    <span class="toast-icon"><svg class="icon"><use href="#${ICONS[type]}"></use></svg></span>
    <div class="toast-copy">
      <strong>${esc(title)}</strong>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${options.actionLabel ? `<button class="toast-action" type="button">${esc(options.actionLabel)}</button>` : ''}
    </div>
    <button class="icon-btn toast-close" type="button" aria-label="Fechar aviso">
      <svg class="icon"><use href="#i-x"></use></svg>
    </button>
    ${duration > 0 ? `<span class="toast-progress" style="animation-duration:${duration}ms"></span>` : ''}
  `;

  const close = () => dismiss(element);
  element.querySelector('.toast-close')?.addEventListener('click', close);
  if (options.action && options.actionLabel) {
    element.querySelector('.toast-action')?.addEventListener('click', () => {
      options.action();
      close();
    });
  }

  stack.prepend(element);
  while (stack.children.length > 4) {
    dismiss(stack.lastElementChild);
  }

  if (duration > 0) {
    const timer = setTimeout(close, duration);
    element.addEventListener('mouseenter', () => clearTimeout(timer), { once: true });
  }

  return { dismiss: close };
}

toast.success = (title, message, options = {}) => toast(title, message, { ...options, type: 'success' });
toast.error = (title, message, options = {}) => toast(title, message, { ...options, type: 'error' });
toast.warning = (title, message, options = {}) => toast(title, message, { ...options, type: 'warning' });
toast.info = (title, message, options = {}) => toast(title, message, { ...options, type: 'info' });
