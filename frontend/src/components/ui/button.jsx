import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

/**
 * Buttons.
 *
 * Variants, in order of emphasis:
 *   default              the one primary action in a region (solid accent)
 *   outline              secondary actions (bordered, on the surface)
 *   secondary            tonal fill, for toggles and a "selected" state
 *   ghost                tertiary / inline actions
 *   destructive          irreversible action (solid)
 *   destructive-outline  a destructive option that is not the default choice
 *   link                 inline text action
 *
 * Sizes: xs (28px) | sm (32px) | default (36px) | lg (40px) | icon (36px) | icon-sm (32px).
 * Icons inside are sized by the button (16px; 14px at xs / sm / icon-sm).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-elev-1 hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-elev-1 hover:bg-destructive/90",
        "destructive-outline":
          "border border-bad/30 bg-card text-bad hover:bg-bad-muted",
        outline:
          "border border-input bg-card text-foreground shadow-elev-1 hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        ghost: "text-foreground/85 hover:bg-muted hover:text-foreground",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4",
        xs: "h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-[13px] [&_svg]:size-3.5",
        lg: "h-10 px-5 text-[15px]",
        icon: "size-9",
        "icon-sm": "size-8 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
