/* Cliente da base SQLite no renderer. Todas as consultas passam pelo main process via IPC. */

export const dbAvailable = () => Boolean(window.desktop?.dbQuery);

async function call(channel, payload = {}) {
  if (!dbAvailable()) throw new Error('Banco de dados indisponível (somente no aplicativo desktop).');
  const response = await window.desktop.dbQuery(channel, payload);
  if (!response?.ok) throw new Error(response?.error || 'Falha na consulta ao banco.');
  return response.result;
}

export const dbOpenDialog = () => window.desktop?.dbOpenDialog?.() || Promise.resolve({ opened: false });
export const dbInfo = () => window.desktop?.dbInfo?.() || Promise.resolve({ opened: false });
export const dbClose = () => window.desktop?.dbClose?.() || Promise.resolve({ closed: true });

export const dbViewport = (type, bounds, limit) => call('db:viewport', { type, ...bounds, limit });
export const dbRows = (type, ids) => call('db:rows', { type, ids });
export const dbRow = (type, id) => call('db:row', { type, id });
export const dbBounds = (type) => call('db:bounds', { type });
export const dbHotspots = (type, limit) => call('db:hotspots', { type, limit });
export const dbIdsInBounds = (type, bounds, limit) => call('db:ids-in-bounds', { type, ...bounds, limit });
export const dbSearch = (type, term, limit) => call('db:search', { type, term, limit });
export const dbFindById = (type, id) => call('db:find-by-id', { type, id });
export const dbPage = (payload) => call('db:page', payload);
export const dbDistinct = (type, field, limit) => call('db:distinct', { type, field, limit });
export const dbLinks = (pole) => call('db:links', { pole });
