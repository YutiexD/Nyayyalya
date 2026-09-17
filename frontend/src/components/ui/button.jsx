import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-tight transition-all duration-200 active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const TILT_DEG = 12;
const EASE_OUT = 'transform 0.4s cubic-bezier(0.03, 0.98, 0.52, 0.99)';
const EASE_TRACK = 'transform 0.12s ease-out';

const Button = React.forwardRef(({ className, variant, size, asChild = false, style, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  const innerRef = React.useRef(null);
  const mergedRef = useMergedRef(ref, innerRef);
  const [tilt, setTilt] = React.useState({ rx: 0, ry: 0, active: false });
  const raf = React.useRef(null);

  const onMove = React.useCallback((e) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = innerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setTilt({
        rx: (0.5 - y) * TILT_DEG,
        ry: (x - 0.5) * TILT_DEG,
        active: true,
      });
    });
  }, []);

  const onLeave = React.useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setTilt({ rx: 0, ry: 0, active: false });
  }, []);

  const prefersReduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced) {
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={style}
        {...props}
      />
    );
  }

  const tiltStyle = {
    transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(${tilt.active ? 1.04 : 1})`,
    transition: tilt.active ? EASE_TRACK : EASE_OUT,
    transformStyle: 'preserve-3d',
    willChange: 'transform',
    ...style,
  };

  return (
    <span className="inline-block" style={{ perspective: '600px' }}>
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={mergedRef}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        style={tiltStyle}
        {...props}
      />
    </span>
  );
})
Button.displayName = "Button"

function useMergedRef(...refs) {
  return React.useCallback((node) => {
    refs.forEach((r) => {
      if (typeof r === 'function') r(node);
      else if (r) r.current = node;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refs);
}

export { Button, buttonVariants }
