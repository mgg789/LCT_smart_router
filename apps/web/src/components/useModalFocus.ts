import { type RefObject, useEffect, useRef } from 'react';

const layers: symbol[] = [];
const containers = new Map<symbol, HTMLElement>();
const inertClaims = new Map<Element, { original: string | null; count: number }>();
let backgroundObserver: MutationObserver | undefined;

/** Reconcile shared claims so a newer sibling/portal dialog is never inerted by an older layer. */
function syncInertBackground() {
  const topKey = layers.at(-1);
  const active = topKey ? containers.get(topKey) : undefined;
  const nativeModal = document.querySelector('dialog:modal');
  const wanted = new Map<Element, number>();
  for (const container of containers.values()) {
    const claimed = new Set<Element>();
    for (
      let branch: Element | null = container;
      branch?.parentElement;
      branch = branch.parentElement
    ) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling === branch ||
          sibling.contains(active ?? null) ||
          (nativeModal && sibling.contains(nativeModal))
        )
          continue;
        claimed.add(sibling);
      }
      if (branch.parentElement === document.body) break;
    }
    for (const node of claimed) wanted.set(node, (wanted.get(node) ?? 0) + 1);
  }
  for (const [node, claim] of inertClaims) {
    if (wanted.has(node)) continue;
    if (claim.original === null) node.removeAttribute('inert');
    else node.setAttribute('inert', claim.original);
    inertClaims.delete(node);
  }
  for (const [node, count] of wanted) {
    const claim = inertClaims.get(node);
    if (claim) claim.count = count;
    else inertClaims.set(node, { original: node.getAttribute('inert'), count });
    node.setAttribute('inert', '');
  }
}

function registerBackground(key: symbol, container: HTMLElement) {
  containers.set(key, container);
  syncInertBackground();
  if (!backgroundObserver) {
    backgroundObserver = new MutationObserver(syncInertBackground);
    // Include newly mounted portal siblings and native dialog open/close transitions.
    backgroundObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }
}

function unregisterBackground(key: symbol) {
  containers.delete(key);
  syncInertBackground();
  if (!containers.size) {
    backgroundObserver?.disconnect();
    backgroundObserver = undefined;
  }
}

/**
 * How many modal dialogs currently hold the screen, native ones included.
 *
 * The layer stack is already the app's single record of what is modal, so a screen that
 * wants to raise a dialog *on its own* -- not because the dispatcher asked -- can ask here
 * first instead of keeping a second tally. Popping a dialog over a dialog buries whatever
 * the dispatcher was in the middle of.
 */
export function openModalCount(): number {
  return layers.length + (document.querySelector('dialog:modal') ? 1 : 0);
}

const focusable = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]';

function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusable)].filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.matches(':disabled') &&
      !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
      !hasHiddenAncestor(node, root),
  );
}

function hasHiddenAncestor(node: HTMLElement, root: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (current === root) break;
  }
  return false;
}

/** Traps focus and makes background siblings inert; native modal dialogs retain their browser trap. */
export function useModalFocus(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const container = root.current;
    if (!open || !container) return;
    const dialog = container.matches('[role="dialog"],[role="alertdialog"]')
      ? container
      : container.querySelector<HTMLElement>('[role="dialog"],[role="alertdialog"]');
    if (!dialog) return;
    const previous = document.activeElement;
    const key = Symbol('modal');
    layers.push(key);
    registerBackground(key, container);
    const oldTabIndex = dialog.getAttribute('tabindex');
    const oldModal = dialog.getAttribute('aria-modal');
    dialog.tabIndex = -1;
    dialog.setAttribute('aria-modal', 'true');
    const ownsFocus = () => layers.at(-1) === key && !document.querySelector('dialog:modal');
    const focusFirst = () => (tabStops(dialog)[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focusFirst();
    const onFocus = (event: FocusEvent) => {
      if (ownsFocus() && event.target instanceof Node && !dialog.contains(event.target))
        focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!ownsFocus()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const stops = tabStops(dialog);
        const first = stops[0] ?? dialog;
        const last = stops.at(-1) ?? dialog;
        if (
          !stops.length ||
          !dialog.contains(document.activeElement) ||
          document.activeElement === dialog ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      const wasTop = layers.at(-1) === key;
      layers.splice(layers.indexOf(key), 1);
      unregisterBackground(key);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (oldTabIndex === null) dialog.removeAttribute('tabindex');
      else dialog.setAttribute('tabindex', oldTabIndex);
      if (oldModal === null) dialog.removeAttribute('aria-modal');
      else dialog.setAttribute('aria-modal', oldModal);
      if (wasTop && previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [root, open]);
}
