export const trials = [
  ['immediate', 'denied', 'missing'],
  ['held', 'denied', 'missing'],
  ['held', 'missing', 'denied'],
  ['immediate', 'missing', 'denied']
].flatMap(([mode, ...routes], pair) => routes.map((route, position) => ({ mode, route, pair, position })));

// Serialized by Playwright. Only instrument the two fixed synthetic documents.
export function observeRouterClick() {
  if (!/^\/f\/(denied|missing)$/.test(location.pathname) || window !== window.top) return;
  const mode = sessionStorage.getItem('route-evidence-click');
  if (mode !== 'held' && mode !== 'immediate') return;
  const native = EventTarget.prototype.addEventListener;
  const trace = { mode, url: location.href, documentStart: performance.timeOrigin, registrations: [] };
  let pending;
  EventTarget.prototype.addEventListener = function (...args) {
    const [type, listener] = args;
    if (this !== document.documentElement || type !== 'click' || args.length !== 2 || typeof listener !== 'function') {
      return native.apply(this, args);
    }
    // Match the pinned Kit router, not Svelte's own delegated events or other root listeners.
    const source = Function.prototype.toString.call(listener);
    if (!source.includes('composedPath') || !source.includes('SVGAElement')) return native.apply(this, args);
    const entry = { requested: performance.now(), attached: null };
    trace.registrations.push(entry);
    const attach = () => {
      native.apply(this, args);
      entry.attached = performance.now();
    };
    if (mode !== 'held' || trace.windowClosed !== undefined || pending) return attach();
    pending = attach;
  };
  window.finishRouteEvidenceArrival = () => {
    trace.windowClosed = performance.now();
    trace.foreground = document.visibilityState === 'visible' && document.hasFocus();
    pending?.();
    pending = undefined;
    return trace;
  };
}

export function assessArrivalTrials(samples) {
  if (samples.length !== trials.length || new Set(samples.map(({ trace }) => trace?.documentStart)).size !== trials.length) return 'inconclusive';
  const title = samples[0].title;
  const valid = samples.every(({ mode, route, pair, position, destination, trace, navigationStarted, speechRead, arrival, title: spokenTitle, errors }, i) => {
    const expected = trials[i];
    const [{ requested, attached } = {}] = trace?.registrations ?? [];
    if (errors?.length !== 0 || !arrival || !title || title !== spokenTitle || mode !== expected.mode || route !== expected.route ||
      pair !== expected.pair || position !== expected.position || trace?.mode !== mode || !trace.foreground ||
      !destination.endsWith(`/f/${route}`) || trace.url !== destination || trace.registrations.length !== 1 ||
      ![navigationStarted, speechRead, trace.documentStart, requested, attached, trace.windowClosed].every(Number.isFinite) ||
      speechRead < navigationStarted || requested >= trace.windowClosed || attached < requested) return false;
    return mode === 'held' ? attached >= trace.windowClosed : attached < trace.windowClosed;
  });
  if (!valid) return 'inconclusive';
  return samples.every(({ mode, arrival }) => /\bclickable\b/i.test(arrival) === (mode === 'immediate'))
    ? 'clickable-follows-registration' : 'inconclusive';
}
