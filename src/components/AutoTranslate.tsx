import { useEffect } from 'react';
import { usePreferences } from '../lib/preferences';
import { ensureTranslations, cachedTranslation } from '../lib/i18n';

// Runtime auto-translation: walks the rendered DOM, translates visible text
// (and key attributes) to the selected language via the backend gateway, and
// reapplies on dynamic updates. English restores originals. Arabic flips RTL.
// Mark any element with data-no-translate to opt a subtree out.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'SVG', 'PATH']);
const ATTRS = ['placeholder', 'title', 'aria-label'] as const;

const textOriginal = new WeakMap<Text, string>();
const attrOriginal = new WeakMap<Element, Record<string, string>>();

function skip(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName) || e.hasAttribute('data-no-translate') || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}
const hasLetters = (s: string) => /\p{L}{2,}/u.test(s);

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue ?? '';
      if (!hasLetters(v.trim())) return NodeFilter.FILTER_REJECT;
      return skip(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}
function attrEls(root: Element): Element[] {
  const sel = ATTRS.map(a => `[${a}]`).join(',');
  const els = [root, ...Array.from(root.querySelectorAll(sel))].filter(e => e.matches?.(sel) && !skip(e));
  return els;
}

// Collect the English source for every node/attr (storing originals once).
function gather(root: Node) {
  const tNodes = textNodes(root);
  const sources = new Set<string>();
  for (const n of tNodes) {
    if (!textOriginal.has(n)) textOriginal.set(n, (n.nodeValue ?? '').trim());
    sources.add(textOriginal.get(n)!);
  }
  const els = root instanceof Element ? attrEls(root) : [];
  for (const el of els) {
    let orig = attrOriginal.get(el);
    if (!orig) { orig = {}; for (const a of ATTRS) { const v = el.getAttribute(a); if (v && hasLetters(v)) orig[a] = v; } attrOriginal.set(el, orig); }
    for (const a of ATTRS) if (orig[a]) sources.add(orig[a]);
  }
  return { tNodes, els };
}

function apply(tNodes: Text[], els: Element[], lang: string) {
  for (const n of tNodes) {
    const src = textOriginal.get(n); if (src === undefined) continue;
    const tx = lang === 'en' ? src : cachedTranslation(src, lang);
    if (tx === undefined) continue;
    // preserve original leading/trailing whitespace
    const raw = n.nodeValue ?? '';
    const lead = raw.match(/^\s*/)?.[0] ?? ''; const tail = raw.match(/\s*$/)?.[0] ?? '';
    const next = lead + tx + tail;
    if (n.nodeValue !== next) n.nodeValue = next;
  }
  for (const el of els) {
    const orig = attrOriginal.get(el); if (!orig) continue;
    for (const a of ATTRS) {
      const src = orig[a]; if (!src) continue;
      const tx = lang === 'en' ? src : cachedTranslation(src, lang);
      if (tx !== undefined && el.getAttribute(a) !== tx) el.setAttribute(a, tx);
    }
  }
}

export default function AutoTranslate() {
  const { language } = usePreferences();
  useEffect(() => {
    const lang = language || 'en';
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';

    let cancelled = false;
    let timer: number | undefined;

    const pass = async () => {
      const { tNodes, els } = gather(document.body);
      if (lang !== 'en') {
        const sources = [...new Set([...tNodes.map(n => textOriginal.get(n)!), ...els.flatMap(e => Object.values(attrOriginal.get(e) ?? {}))])];
        await ensureTranslations(sources, lang);
      }
      if (!cancelled) apply(tNodes, els, lang);
    };
    void pass();

    // Re-translate on dynamic DOM changes (debounced). Cached → instant + no loop
    // (apply only writes when the value actually changes).
    const obs = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void pass(); }, 250);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { cancelled = true; obs.disconnect(); window.clearTimeout(timer); };
  }, [language]);

  return null;
}
