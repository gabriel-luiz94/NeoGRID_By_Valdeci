/* Aplica o tema salvo antes da primeira pintura, evitando flash. */
(function boot() {
  try {
    const raw = JSON.parse(localStorage.getItem('neogrid.settings.v2') || '{}');
    const root = document.documentElement;
    if (raw.theme === 'light' || raw.theme === 'dark') root.dataset.theme = raw.theme;
    if (['orange', 'cyan', 'green', 'violet'].includes(raw.accent)) root.dataset.accent = raw.accent;
    if (raw.density === 'compact') root.dataset.density = 'compact';
  } catch {
    /* usa o padrão */
  }
})();
