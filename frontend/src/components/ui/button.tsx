import * as React from "react"
import { cn } from "@wandercom/design-system-shared"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "danger"
  size?: "default" | "sm" | "lg"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    let variantClass = ""

    if (variant === "danger") {
      variantClass = "bg-red-600 hover:bg-red-700 text-white"
    } else if (variant === "outline") {
      variantClass = "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
    } else if (variant === "ghost") {
      variantClass = "hover:bg-accent hover:text-accent-foreground"
    } else {
      variantClass = "bg-primary text-primary-foreground hover:bg-primary/90"
    }

    const sizeClass = size === "sm" ? "h-9 px-3 text-sm" : size === "lg" ? "h-11 px-8" : "h-10 px-4"

    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          variantClass,
          sizeClass,
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
