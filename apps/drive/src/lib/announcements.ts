import { createContext, onDestroy } from 'svelte';

export type AnnouncementPriority = 'polite' | 'assertive';
type Announce = (message: string, priority?: AnnouncementPriority) => void;

// Leave an empty interval between messages so a later action can repeat the same text.
const announcementDelay = 100;

export function createAnnouncer(write: (polite: string, assertive: string) => void, modalOpen: () => boolean) {
  const pending = new Map<symbol, { message: string; priority: AnnouncementPriority }>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function resume() {
    if (timer !== undefined || !pending.size || modalOpen()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!pending.size || modalOpen()) return;
      const assertive = new Set<string>();
      const polite = new Set<string>();
      for (const { message, priority } of pending.values()) (priority === 'assertive' ? assertive : polite).add(message);
      pending.clear();
      write([...polite].filter(message => !assertive.has(message)).join(' '), [...assertive].join(' '));
    }, announcementDelay);
  }

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    write('', '');
  }

  function scope() {
    const source = Symbol();
    let active = true;
    const announce: Announce = (message, priority = 'polite') => {
      if (!active || !message.trim()) return;
      if (!pending.size) clear();
      // A newer update supersedes pending feedback from the same caller only.
      pending.set(source, { message, priority });
      resume();
    };
    return { announce, dispose() { active = false; pending.delete(source); } };
  }

  return { scope, resume, clear };
}

export const [getAnnouncer, setAnnouncer] = createContext<ReturnType<typeof createAnnouncer>>();

export function useAnnounce(): Announce {
  const { announce, dispose } = getAnnouncer().scope();
  onDestroy(dispose);
  return announce;
}
