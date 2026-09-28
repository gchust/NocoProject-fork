/** Key predicates for the NocoProject shortcuts (§H 7), kept apart so they can be tested without rendering. */

/** Typing into a field, an editor or a select must never trigger a single-letter shortcut. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('[contenteditable="true"], [role="combobox"]') !== null;
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'k'
  );
}

/** The modifier to show next to a shortcut that accepts ⌘ or Ctrl: ⌘ on Apple devices, Ctrl elsewhere. */
export function modifierKeyLabel(
  platform: string = typeof navigator === 'undefined'
    ? ''
    : navigator.platform || navigator.userAgent,
): '⌘' | 'Ctrl' {
  return /mac|iphone|ipad|ipod/iu.test(platform) ? '⌘' : 'Ctrl';
}
