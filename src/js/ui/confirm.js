import { $, closeDialog, openDialog } from '../core/dom.js';

export function confirmAction({
  title = 'Confirmar ação',
  text = 'Esta ação não pode ser desfeita.',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = true,
} = {}) {
  const dialog = $('#confirmDialog');
  if (!dialog) return Promise.resolve(false);
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  const go = $('#confirmGo');
  go.textContent = confirmLabel;
  go.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  const cancel = dialog.querySelector('button[value="cancel"]');
  if (cancel) cancel.textContent = cancelLabel;

  return new Promise((resolve) => {
    const controller = new AbortController();
    const finish = (result) => {
      controller.abort();
      closeDialog(dialog);
      resolve(result);
    };
    dialog.addEventListener('close', () => {
      controller.abort();
      resolve(false);
    }, { once: true });
    go.addEventListener('click', () => finish(true), { signal: controller.signal });
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]') || event.target.closest('button[value="cancel"]')) finish(false);
    }, { signal: controller.signal });
    openDialog(dialog);
  });
}
