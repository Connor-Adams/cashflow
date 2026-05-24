import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import clsx from "clsx"

const cn = (...args: (string | Record<string, boolean> | undefined)[]) => clsx(...args)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "danger" | "primary" | "secondary" | "destructive" | "link"
  size?: "default" | "sm" | "lg"
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "button"
    const sizeClass = size === "sm" ? "h-9 px-3 text-sm" : size === "lg" ? "h-11 px-8" : "h-10 px-4"
    const baseClass = "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50"

    if (variant === "primary" || variant === "default") {
      return (
        <Comp
          ref={ref}
          style={{
            backgroundColor: `var(--primary)`,
            color: `var(--primary-foreground)`,
          }}
          className={cn(baseClass, "hover:opacity-90", sizeClass, className)}
          {...props}
        />
      )
    }

    if (variant === "secondary") {
      return (
        <Comp
          ref={ref}
          style={{
            backgroundColor: `var(--bg2)`,
            color: `var(--fg)`,
            borderColor: `var(--border)`,
          }}
          className={cn(baseClass, "border hover:opacity-90", sizeClass, className)}
          {...props}
        />
      )
    }

    let variantClass = ""
    if (variant === "danger" || variant === "destructive") {
      variantClass = "border border-[var(--danger)] bg-[var(--danger)] text-[var(--destructive-foreground)] hover:bg-[var(--rust-500)]"
    } else if (variant === "link") {
      variantClass = "text-primary underline-offset-4 hover:underline"
    } else if (variant === "outline") {
      variantClass = "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
    } else if (variant === "ghost") {
      variantClass = "hover:bg-accent hover:text-accent-foreground"
    }

    return (
      <Comp
        ref={ref}
        className={cn(
          baseClass,
          "focus-visible:ring-ring",
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
