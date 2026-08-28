import { useSyncExternalStore } from 'react';

// Tenant-operator display preferences (currency + UI locale). Persisted to
// localStorage and read by the formatters so changing currency/locale updates
// figures across the app. Currency here is a display/formatting preference —
// amounts are stored in the clinic's operating currency, not converted.

export interface CurrencyOption { code: string; label: string; locale: string }
export const CURRENCIES: CurrencyOption[] = [
  { code: 'GBP', label: '£ GBP', locale: 'en-GB' },
  { code: 'USD', label: '$ USD', locale: 'en-US' },
  { code: 'EUR', label: '€ EUR', locale: 'de-DE' },
  { code: 'AUD', label: '$ AUD', locale: 'en-AU' },
  { code: 'CAD', label: '$ CAD', locale: 'en-CA' },
  { code: 'AED', label: 'د.إ AED', locale: 'ar-AE' },
];

export interface LanguageOption { code: string; label: string }
export const LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'ar', label: 'العربية' },
];

const CURRENCY_KEY = 'cc_currency';
const LANG_KEY = 'cc_language';
const EVENT = 'cc-prefs-changed';

export function getCurrency(): string {
  return (typeof localStorage !== 'undefined' && localStorage.getItem(CURRENCY_KEY)) || 'USD';
}
export function getLanguage(): string {
  return (typeof localStorage !== 'undefined' && localStorage.getItem(LANG_KEY)) || 'en';
}
export function getCurrencyLocale(): string {
  return CURRENCIES.find(c => c.code === getCurrency())?.locale ?? 'en-US';
}
export function getLocale(): string {
  const language = getLanguage();
  return language === 'en' ? getCurrencyLocale() : language;
}

export function setCurrency(code: string) {
  localStorage.setItem(CURRENCY_KEY, code);
  window.dispatchEvent(new Event(EVENT));
}
export function setLanguage(code: string) {
  localStorage.setItem(LANG_KEY, code);
  document.documentElement.lang = code;
  document.documentElement.dir = code === 'ar' ? 'rtl' : 'ltr';
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb); // sync across tabs
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb); };
}

// One snapshot string so consumers (and a top-level remount key) update together.
function snapshot() { return `${getCurrency()}|${getLanguage()}`; }

export function usePreferences() {
  const snap = useSyncExternalStore(subscribe, snapshot, () => 'USD|en');
  const [currency, language] = snap.split('|');
  return { currency, language, setCurrency, setLanguage };
}
