export const safeLocalStorage = (() => {
  try {
    const ls = window.localStorage;
    if (ls) return ls;
  } catch (_err) {
    // ignore
  }
  return {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  };
})();

export function getLS(key, fallback = null) {
  try {
    const raw = safeLocalStorage.getItem(key);
    return raw === null || raw === undefined ? fallback : raw;
  } catch (_err) {
    return fallback;
  }
}

export function setLS(key, value) {
  try {
    safeLocalStorage.setItem(key, value);
  } catch (_err) {
    // ignore write failures
  }
}

export function removeLS(key) {
  try {
    safeLocalStorage.removeItem(key);
  } catch (_err) {
    // ignore
  }
}
