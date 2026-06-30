import { useSyncExternalStore } from 'react';

// Local UI preferences: sidebar collapse + accent theme. Persisted to localStorage
// and applied as CSS variables on <html> so the whole app re-themes instantly.

const COLLAPSE_KEY = 'cc_sidebar_collapsed';
const ACCENT_KEY = 'cc_accent';
const SECTIONS_KEY = 'cc_nav_sections_collapsed';
const EVENT = 'cc-ui-changed';

export interface Accent { key: string; label: string; color: string; base: string; soft: string; mid: string; glow: string }
export const ACCENTS: Accent[] = [
  { key: 'indigo', label: 'Indigo', color: '#4F46E5', base: '#4F46E5', soft: 'rgba(79,70,229,0.08)', mid: 'rgba(79,70,229,0.16)', glow: 'rgba(79,70,229,0.24)' },
  { key: 'violet', label: 'Violet', color: '#7C3AED', base: '#7C3AED', soft: 'rgba(124,58,237,0.08)', mid: 'rgba(124,58,237,0.16)', glow: 'rgba(124,58,237,0.24)' },
  { key: 'blue', label: 'Blue', color: '#2563EB', base: '#2563EB', soft: 'rgba(37,99,235,0.08)', mid: 'rgba(37,99,235,0.16)', glow: 'rgba(37,99,235,0.24)' },
  { key: 'teal', label: 'Teal', color: '#0D9488', base: '#0D9488', soft: 'rgba(13,148,136,0.08)', mid: 'rgba(13,148,136,0.16)', glow: 'rgba(13,148,136,0.24)' },
  { key: 'rose', label: 'Rose', color: '#E11D48', base: '#E11D48', soft: 'rgba(225,29,72,0.08)', mid: 'rgba(225,29,72,0.16)', glow: 'rgba(225,29,72,0.24)' },
];

export function getCollapsed(): boolean { return typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1'; }
export function getAccent(): string { return (typeof localStorage !== 'undefined' && localStorage.getItem(ACCENT_KEY)) || 'indigo'; }

function applyCollapsed(v: boolean) { document.documentElement.style.setProperty('--sidebar-w', v ? '68px' : '260px'); }
function applyAccent(key: string) {
  const a = ACCENTS.find(x => x.key === key) ?? ACCENTS[0];
  const r = document.documentElement.style;
  r.setProperty('--indigo', a.base);
  r.setProperty('--indigo-soft', a.soft);
  r.setProperty('--indigo-mid', a.mid);
  r.setProperty('--indigo-glow', a.glow);
}

export function setCollapsed(v: boolean) { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); applyCollapsed(v); window.dispatchEvent(new Event(EVENT)); }
export function setAccent(key: string) { localStorage.setItem(ACCENT_KEY, key); applyAccent(key); window.dispatchEvent(new Event(EVENT)); }

// Per-section collapse state for the sidebar nav (persisted, comma-joined labels).
export function getCollapsedSections(): string[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(SECTIONS_KEY);
  return raw ? raw.split(',').filter(Boolean) : [];
}
export function toggleSection(label: string) {
  const current = new Set(getCollapsedSections());
  if (current.has(label)) current.delete(label); else current.add(label);
  localStorage.setItem(SECTIONS_KEY, [...current].join(','));
  window.dispatchEvent(new Event(EVENT));
}

// Apply saved prefs at startup (call once before first paint).
export function initUiPrefs() { applyCollapsed(getCollapsed()); applyAccent(getAccent()); }

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb); };
}
function snapshot() { return `${getCollapsed() ? '1' : '0'}|${getAccent()}|${getCollapsedSections().join(',')}`; }

export function useUiPrefs() {
  const snap = useSyncExternalStore(subscribe, snapshot, () => '0|indigo|');
  const [c, accent, sections] = snap.split('|');
  return {
    collapsed: c === '1',
    accent,
    collapsedSections: sections ? sections.split(',').filter(Boolean) : [],
    setCollapsed,
    setAccent,
    toggleSection,
  };
}
