/**
 * GSAP helpers.
 *
 * Animation here is a reading aid, never decoration. Content arrives in the order a
 * person reads it, movement is short and small, and nothing loops.
 *
 * Hero elements (above the fold) animate in a staggered sequence on mount.
 * Everything below the fold animates only when scrolled into view via
 * ScrollTrigger. Sibling groups (e.g. card grids) stagger as a batch.
 *
 * `prefers-reduced-motion` is honoured by showing content immediately.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const MOTION = Object.freeze({
  ease: 'power3.out',
  fast: 0.35,
  base: 0.8,
  stagger: 0.1,
});

/**
 * Group sibling `.will-reveal` elements so they stagger together.
 * Isolated elements (no adjacent siblings with the class) animate solo.
 */
function groupSiblings(elements, selectorClass) {
  const groups = [];
  const seen = new Set();

  for (const el of elements) {
    if (seen.has(el)) continue;

    const parent = el.parentElement;
    if (!parent) {
      groups.push([el]);
      seen.add(el);
      continue;
    }

    const siblings = elements.filter(
      (other) => other.parentElement === parent && other !== el && !seen.has(other),
    );

    if (siblings.length > 0) {
      const group = [el, ...siblings];
      group.forEach((g) => seen.add(g));
      groups.push(group);
    } else {
      seen.add(el);
      groups.push([el]);
    }
  }

  return groups;
}

/**
 * Reveal `.will-reveal` elements inside the returned ref.
 *
 * Hero elements (first `<section>`): staggered timeline on mount with slide-up + fade.
 * Scroll elements: slide-up + fade + subtle scale, triggered at 88% viewport.
 * Sibling groups: stagger as a batch when the first element enters the viewport.
 */
export function useReveal(selector = '.will-reveal', { deps = [] } = {}) {
  const scope = useRef(null);
  const selectorClass = selector.replace(/^\./, '');

  useLayoutEffect(() => {
    const root = scope.current;
    if (!root) return undefined;

    const reduced = prefersReducedMotion();
    const allElements = Array.from(root.querySelectorAll(selector));

    if (reduced) {
      allElements.forEach((el) => el.classList.remove(selectorClass));
      return undefined;
    }

    const cleanup = (els) => {
      els.forEach((el) => {
        el.classList.remove(selectorClass);
        gsap.set(el, { clearProps: 'opacity,transform,will-change' });
      });
    };

    const ctx = gsap.context(() => {
      const firstSection = root.querySelector('section');
      const heroElements = [];
      const scrollElements = [];

      allElements.forEach((el) => {
        if (firstSection && firstSection.contains(el)) {
          heroElements.push(el);
        } else {
          scrollElements.push(el);
        }
      });

      // ── Hero: staggered entrance on mount ──
      if (heroElements.length) {
        gsap.fromTo(
          heroElements,
          { opacity: 0, y: 32, scale: 0.98, force3D: true },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            force3D: true,
            duration: MOTION.base,
            ease: MOTION.ease,
            stagger: MOTION.stagger,
            delay: 0.15,
            onComplete: () => cleanup(heroElements),
          },
        );
      }

      // ── Scroll: group siblings, then animate each group ──
      const groups = groupSiblings(scrollElements, selectorClass);

      groups.forEach((group) => {
        if (group.length === 1) {
          // Single element — animate solo on scroll
          gsap.fromTo(
            group[0],
            { opacity: 0, y: 40, scale: 0.97, force3D: true },
            {
              opacity: 1,
              y: 0,
              scale: 1,
              force3D: true,
              duration: MOTION.base,
              ease: MOTION.ease,
              scrollTrigger: {
                trigger: group[0],
                start: 'top 88%',
                once: true,
              },
              onComplete: () => cleanup(group),
            },
          );
        } else {
          // Sibling group — stagger when first element enters viewport
          gsap.fromTo(
            group,
            { opacity: 0, y: 40, scale: 0.97, force3D: true },
            {
              opacity: 1,
              y: 0,
              scale: 1,
              force3D: true,
              duration: MOTION.base,
              ease: MOTION.ease,
              stagger: 0.12,
              scrollTrigger: {
                trigger: group[0],
                start: 'top 88%',
                once: true,
              },
              onComplete: () => cleanup(group),
            },
          );
        }
      });
    }, root);

    return () => {
      ctx.revert();
      allElements.forEach((el) => {
        if (el.classList.contains(selectorClass)) {
          el.classList.remove(selectorClass);
          gsap.set(el, { clearProps: 'all' });
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return scope;
}

/**
 * Count a number up to its value — only for genuine quantities.
 */
export function useCountUp(ref, value, { duration = 0.8 } = {}) {
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
