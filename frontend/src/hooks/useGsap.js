/**
 * GSAP helpers.
 *
 * # The rule this file exists to enforce
 *
 * Animation here is a reading aid, never decoration. Content arrives in the order a
 * person reads it, movement is short and small, and nothing loops. On a projector in
 * front of judges, a UI that bounces reads as a toy; a UI where the eye is guided to
 * the next fact reads as a product.
 *
 * Every timeline is built inside a `gsap.context` scoped to a ref, so React strict
 * mode's double-invoke and any unmount both revert cleanly instead of leaving
 * half-played transforms on the DOM.
 *
 * `prefers-reduced-motion` is honoured by skipping the timeline entirely and clearing
 * the pre-animation opacity, so the same markup renders finished rather than blank.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Shared easing and durations, so timings do not drift between screens. */
export const MOTION = Object.freeze({
  ease: 'power2.out',
  fast: 0.28,
  base: 0.42,
  stagger: 0.045,
});

/**
 * Reveal the elements matching `selector` inside the returned ref, once, on mount.
 *
 * @param {string} selector defaults to `.will-reveal`, which starts at opacity 0
 * @param {object} [opts]
 * @param {any[]} [opts.deps] re-run when these change (e.g. after data loads)
 * @param {number} [opts.y] travel distance in px
 */
export function useReveal(selector = '.will-reveal', { deps = [], y = 12 } = {}) {
  const scope = useRef(null);
  // The bare class name behind the selector, which is what actually has to come off.
  const selectorClass = selector.replace(/^\./, '');

  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return undefined;

    const reduced = prefersReducedMotion();
    const tweens = new Set();

    /**
     * Reveal a batch of elements, once each, PERMANENTLY.
     *
     * The class is removed rather than the opacity overridden. `.will-reveal` is
     * `opacity: 0` in CSS so that nothing flashes in finished before its entrance
     * runs; once an element has arrived, that rule must stop applying to it forever.
     * Leaving the class on and relying on an inline style meant any later
     * `clearProps` — or a GSAP context revert on an effect re-run — dropped the
     * element back to invisible, and because it had already been marked as done, no
     * subsequent pass would bring it back. The result was a page that rendered its
     * header and nothing else.
     */
    const reveal = (targets) => {
      const fresh = Array.from(targets).filter((el) => el.classList.contains(selectorClass));
      if (!fresh.length) return;

      if (reduced) {
        // Not "animate faster" — do not animate, and make sure nothing stays hidden.
        fresh.forEach((el) => el.classList.remove(selectorClass));
        return;
      }

      const tween = gsap.fromTo(
        fresh,
        { opacity: 0, y },
        {
          opacity: 1,
          y: 0,
          duration: MOTION.base,
          ease: MOTION.ease,
          stagger: MOTION.stagger,
          onComplete: () => {
            // Hand control back to CSS with the element in its finished state.
            fresh.forEach((el) => {
              el.classList.remove(selectorClass);
              gsap.set(el, { clearProps: 'opacity,transform' });
            });
          },
        }
      );
      tweens.add(tween);
    };

    reveal(root.querySelectorAll(selector));

    /**
     * Watch for elements that arrive later.
     *
     * A Radix tab panel, a section that appears once a query resolves, a row added by
     * a mutation — all mount after the first pass, and all start invisible. Observing
     * the subtree removes that failure mode outright rather than leaving every caller
     * to get a `deps` array exactly right and fail silently when they do not.
     */
    const observer = new MutationObserver((records) => {
      const added = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(selector)) added.push(node);
          if (node.querySelectorAll) added.push(...node.querySelectorAll(selector));
        }
      }
      if (added.length) reveal(added);
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      // Kill in flight, but never revert: reverting would restore `opacity: 0` on
      // elements the user is already looking at.
      tweens.forEach((t) => t.kill());
      tweens.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return scope;
}

/**
 * Count a number up to its value.
 *
 * Used only for figures that are genuinely a quantity (entries checked, exhibits in a
 * pack). Never for a hash, a code, or anything a viewer might read mid-flight and
 * believe — a digit that changes while being read is worse than no animation.
 */
export function useCountUp(ref, value, { duration = 0.6 } = {}) {
  useEffect(() => {
    const node = ref.current;
    if (!node || !Number.isFinite(value)) return undefined;

    if (prefersReducedMotion()) {
      node.textContent = String(value);
      return undefined;
    }

    const state = { n: 0 };
    const tween = gsap.to(state, {
      n: value,
      duration,
      ease: MOTION.ease,
      onUpdate: () => {
        node.textContent = String(Math.round(state.n));
      },
      onComplete: () => {
        node.textContent = String(value);
      },
    });
    return () => tween.kill();
  }, [ref, value, duration]);
}
