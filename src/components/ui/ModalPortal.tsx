import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

let openModals = 0;
let bodyOverflow = '';

// Keep fixed dialogs outside animated or scrolling ancestors.
export function ModalPortal({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  // Capture the opener before children with autoFocus are mounted.
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    if (openModals++ === 0) bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = root.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) {
      dialog.tabIndex = -1;
      if (!root.current?.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    }
    return () => {
      if (--openModals === 0) document.body.style.overflow = bodyOverflow;
      previousFocus.current?.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(<div ref={root} style={{ display: 'contents' }} onKeyDown={event => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const items = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
    if (!items?.length) { event.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current?.querySelector('[role="dialog"]'))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current?.querySelector('[role="dialog"]'))) {
      event.preventDefault(); first.focus();
    }
  }}>{children}</div>, document.body);
}
