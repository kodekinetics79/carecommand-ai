import { expect, type Page } from '@playwright/test';

/**
 * Deterministic browser accessibility contract for rendered application state.
 * This is intentionally scoped to structural name/role/document defects; it is
 * not represented as a substitute for axe, contrast analysis, or assistive-
 * technology certification.
 */
export async function assertAccessibilityContract(page: Page, context: string) {
  await page.waitForFunction(() => document.readyState === 'complete');
  const violations = await page.evaluate(() => {
    const issues: string[] = [];
    if (!document.documentElement.lang.trim()) issues.push('document language is missing');
    if (!document.title.trim()) issues.push('document title is missing');

    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && !element.hidden;
    };
    const labelledByText = (element: Element) => (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    const explicitName = (element: HTMLElement) => {
      const control = element as HTMLInputElement;
      const labels = 'labels' in control && control.labels
        ? [...control.labels].map(label => label.textContent ?? '').join(' ').trim()
        : '';
      return (
        element.getAttribute('aria-label')
        || labelledByText(element)
        || labels
        || element.getAttribute('title')
        || ''
      ).trim();
    };
    const accessibleName = (element: HTMLElement) => {
      const explicit = explicitName(element);
      if (explicit) return explicit;
      if (element.matches('button, a[href], [role="button"], [role="link"]')) {
        return (element.textContent ?? '').trim();
      }
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) {
        return element.value.trim();
      }
      return '';
    };

    for (const element of document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"], input:not([type="hidden"]), select, textarea')) {
      if (visible(element) && !accessibleName(element)) {
        issues.push(`unnamed interactive element: ${element.tagName.toLowerCase()}`);
      }
    }
    for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
      if (visible(image) && !image.hasAttribute('alt')) issues.push('image missing alt');
    }
    for (const element of document.querySelectorAll<HTMLElement>('[tabindex]')) {
      const value = Number(element.getAttribute('tabindex'));
      if (Number.isFinite(value) && value > 0) issues.push(`positive tabindex: ${value}`);
    }
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map(element => element.id).filter(Boolean);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    for (const id of duplicates) issues.push(`duplicate id: ${id}`);
    return issues;
  });
  expect(violations, `accessibility contract violations at ${context}`).toEqual([]);
}
