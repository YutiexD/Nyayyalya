import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[72px] w-full rounded-md border border-input bg-card px-3 py-2 text-base leading-relaxed transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 aria-[invalid=true]:border-bad disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-60 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />
  );
})
Textarea.displayName = "Textarea"

export { Textarea }
