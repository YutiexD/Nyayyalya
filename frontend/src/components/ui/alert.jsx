import * as React from "react"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-[0.9rem] [&>svg]:size-4 [&>svg]:text-muted-foreground [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "bg-card text-foreground",
        destructive: "border-bad/25 bg-bad-muted text-foreground [&>svg]:text-bad [&>h5]:text-bad",
        danger: "border-bad/25 bg-bad-muted text-foreground [&>svg]:text-bad [&>h5]:text-bad",
        warning: "border-warn/25 bg-warn-muted text-foreground [&>svg]:text-warn [&>h5]:text-warn",
        success: "border-ok/25 bg-ok-muted text-foreground [&>svg]:text-ok [&>h5]:text-ok",
        info: "border-info/20 bg-info-muted text-foreground [&>svg]:text-info [&>h5]:text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props} />
))
Alert.displayName = "Alert"

const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-semibold leading-snug", className)}
    {...props} />
))
AlertTitle.displayName = "AlertTitle"

const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props} />
))
AlertDescription.displayName = "AlertDescription"

export { Alert, AlertTitle, AlertDescription }
