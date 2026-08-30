import type { Page, Request } from '@playwright/test';

/**
 * What "the browser reported a problem" means, split into the two things it
 * actually is.
 *
 * A journey must not produce network failures — a refused connection, a CORS
 * rejection, a socket that died mid-response — and must not receive an error
 * status. Both are recorded here so a spec can assert on them.
 *
 * Exactly one kind of reported failure is not a failure: a request the app
 * cancelled ITSELF because the surface that asked for it went away. Every panel
 * loader aborts its in-flight fetch on unmount (src/hooks/useResource.ts owns
 * the AbortController), so clicking from the dashboard to another route while a
 * panel is still loading correctly cancels that panel's request. Chromium
 * reports the cancellation as `net::ERR_ABORTED` on a `requestfailed` event,
 * which is indistinguishable from a real failure until you ask WHERE the page
 * was when the request was issued and where it is now.
 *
 * That is the question this asks, and the only ground on which anything is
 * excused: the request was aborted AND the page has since left the route that
 * issued it. An `net::ERR_ABORTED` raised while the page is still sitting on
 * the very route that asked for the data is NOT excused — that is a component
 * tearing down and re-issuing its own request, a real defect, and it still
 * fails the spec. Every other error text still fails on the spot, whatever
 * route the page is on.
 */
const ABORTED = 'net::ERR_ABORTED';

export interface NetworkWatch {
  /**
   * Transport failures the product must never produce. Assert this is empty.
   */
  readonly failures: string[];
  /**
   * Responses the server refused or could not produce (4xx/5xx). `requestfailed`
   * never fires for these — an HTTP 500 is a successful exchange as far as the
   * network is concerned — so a spec that only watched `requestfailed` could
   * never have caught the silent 500 or 403 it was written to catch. This is
   * that check. Assert this is empty.
   */
  readonly errorResponses: string[];
  /**
   * Requests the app cancelled by leaving the surface that asked for them.
   * Recorded rather than discarded so the evidence stays in the run.
   */
  readonly cancelledByNavigation: string[];
  /** Start watching a page (or a second tab). Call before the journey begins. */
  watch(page: Page): void;
}

export function watchNetwork(): NetworkWatch {
  const failures: string[] = [];
  const errorResponses: string[] = [];
  const cancelledByNavigation: string[] = [];
  // Where the page was when each request left. Weak so a long journey does not
  // retain every request it ever made.
  const routeWhenIssued = new WeakMap<Request, string>();

  const watch = (page: Page) => {
    page.on('request', request => { routeWhenIssued.set(request, page.url()); });
    page.on('requestfailed', request => {
      const errorText = request.failure()?.errorText ?? '';
      const line = `${request.method()} ${request.url()} ${errorText}`;
      const issuedOn = routeWhenIssued.get(request);
      // Unknown origin route (the request predates the watcher) counts as a
      // failure: nothing is excused on an assumption.
      const leftTheRoute = issuedOn !== undefined && issuedOn !== page.url();
      if (errorText === ABORTED && leftTheRoute) cancelledByNavigation.push(line);
      else failures.push(line);
    });
    page.on('response', response => {
      if (response.status() >= 400) {
        errorResponses.push(`${response.request().method()} ${response.url()} ${response.status()}`);
      }
    });
  };

  return { failures, errorResponses, cancelledByNavigation, watch };
}
