import { useEffect, useRef } from "react";

/**
 * Tracks whether a horizontally scrolling row still has content off screen,
 * so the trailing fade can be hidden at the end of the row. Overflow is
 * invisible otherwise: the last tab simply looks missing.
 */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const atEnd =
        element.scrollLeft + element.clientWidth >= element.scrollWidth - 2;
      element.dataset.atEnd = String(atEnd);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  return ref;
}
