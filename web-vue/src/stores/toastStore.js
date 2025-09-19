import { reactive } from 'vue';

let counter = 0;
const toasts = reactive([]);

export function useToastStore() {
  function pushToast(message, intent = 'err', ttl = 3200) {
    const id = ++counter;
    const entry = { id, message: String(message), intent, createdAt: Date.now() };
    toasts.push(entry);
    if (ttl > 0) {
      window.setTimeout(() => removeToast(id), ttl);
    }
    return id;
  }

  function removeToast(id) {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx >= 0) {
      toasts.splice(idx, 1);
    }
  }

  return {
    toasts,
    pushToast,
    removeToast,
  };
}
