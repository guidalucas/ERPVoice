type AuthSession = {
  token: string;
  phoneNumber: string;
};

const TOKEN_KEY = 'erpvoice.auth.token';
const PHONE_KEY = 'erpvoice.auth.phoneNumber';

const listeners = new Set<() => void>();

const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

const readStoredValue = (key: string) => {
  if (!isBrowser) {
    return null;
  }

  return window.localStorage.getItem(key);
};

const writeStoredValue = (key: string, value: string | null) => {
  if (!isBrowser) {
    return;
  }

  if (value) {
    window.localStorage.setItem(key, value);
    return;
  }

  window.localStorage.removeItem(key);
};

let currentToken = readStoredValue(TOKEN_KEY);
let currentPhoneNumber = readStoredValue(PHONE_KEY);

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const getAuthToken = () => currentToken;

export const getAuthPhoneNumber = () => currentPhoneNumber;

export const getAuthSession = (): AuthSession | null =>
  currentToken && currentPhoneNumber ? { token: currentToken, phoneNumber: currentPhoneNumber } : null;

export const setAuthSession = (session: AuthSession) => {
  currentToken = session.token;
  currentPhoneNumber = session.phoneNumber;
  writeStoredValue(TOKEN_KEY, currentToken);
  writeStoredValue(PHONE_KEY, currentPhoneNumber);
  emit();
};

export const clearAuthSession = () => {
  currentToken = null;
  currentPhoneNumber = null;
  writeStoredValue(TOKEN_KEY, null);
  writeStoredValue(PHONE_KEY, null);
  emit();
};

export const subscribeAuthSession = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};