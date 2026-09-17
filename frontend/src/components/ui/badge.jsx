import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

/**
 * A status pill.
 *
 * Status variants are soft tints with AA-contrast text:
 *   neutral | info | success | warning | danger | muted
 * (`ok` / `warn` / `bad` are accepted as aliases of success / warning / danger).
 * The shadcn originals (default | secondary | destructive | outline) still work.
 *
 * `dot` adds a small leading dot in the text colour. `size`: sm | default | lg.
 */
const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border font-medium leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border bg-transparent text-foreground",

        neutral: "border-border bg-muted/70 text-foreground",
        info: "border-info/15 bg-info-muted text-info",
        success: "border-ok/15 bg-ok-muted text-ok",
        warning: "border-warn/20 bg-warn-muted text-warn",
        danger: "border-bad/15 bg-bad-muted text-bad",
        muted: "border-transparent bg-muted text-muted-foreground",

        ok: "border-ok/15 bg-ok-muted text-ok",
        warn: "border-warn/20 bg-warn-muted text-warn",
        bad: "border-bad/15 bg-bad-muted text-bad",
      },
      size: {
        sm: "min-h-5 px-2 py-0.5 text-[11px]",
        default: "min-h-6 px-2.5 py-1 text-xs",
        lg: "min-h-7 px-3 py-1 text-[13px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Map a semantic tone (ok / warn / bad / info / neutral / muted) to a Badge variant. */
const TONE_TO_BADGE = Object.freeze({
  ok: "success",
  success: "success",
  warn: "warning",
  warning: "warning",
  bad: "danger",
  danger: "danger",
  info: "info",
  neutral: "neutral",
  muted: "muted",
})

const Badge = React.forwardRef(function Badge(
  { className, variant, size, dot = false, children, ...props },
  ref
) {
  return (
    <span ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
})

export { Badge, badgeVariants, TONE_TO_BADGE }
