const listeners = new Map();

export const bus = {
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => bus.off(name, handler);
  },
  once(name, handler) {
    const off = bus.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  },
  off(name, handler) {
    listeners.get(name)?.delete(handler);
  },
  emit(name, payload) {
    for (const handler of listeners.get(name) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus:${name}]`, error);
      }
    }
    for (const handler of listeners.get('*') || []) {
      try {
        handler({ name, payload });
      } catch (error) {
        console.error('[bus:*]', error);
      }
    }
  },
};
