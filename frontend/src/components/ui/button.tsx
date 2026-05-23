import * as React from "react"
import clsx from "clsx"

const cn = (...args: (string | Record<string, boolean> | undefined)[]) => clsx(...args)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "danger" | "primary" | "secondary" | "destructive" | "link"
  size?: "default" | "sm" | "lg"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    let variantClass = ""

    if (variant === "danger" || variant === "destructive") {
      variantClass = "border border-[var(--danger)] bg-[var(--danger)] text-[var(--destructive-foreground)] hover:bg-[var(--rust-500)]"
    } else if (variant === "link") {
      variantClass = "text-primary underline-offset-4 hover:underline"
    } else if (variant === "outline") {
      variantClass = "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
    } else if (variant === "ghost") {
      variantClass = "hover:bg-accent hover:text-accent-foreground"
    } else if (variant === "primary" || variant === "default") {
      return (
        <button
          ref={ref}
          style={{
            backgroundColor: `var(--primary)`,
            color: `var(--primary-foreground)`,
          }}
          className={cn(
            "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 hover:opacity-90",
            size === "sm" ? "h-9 px-3 text-sm" : size === "lg" ? "h-11 px-8" : "h-10 px-4",
            className
          )}
          {...props}
        />
      )
    } else if (variant === "secondary") {
      return (
        <button
          ref={ref}
          style={{
            backgroundColor: `var(--bg2)`,
            color: `var(--fg)`,
            borderColor: `var(--border)`,
          }}
          className={cn(
            "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 border hover:opacity-90",
            size === "sm" ? "h-9 px-3 text-sm" : size === "lg" ? "h-11 px-8" : "h-10 px-4",
            className
          )}
          {...props}
        />
      )
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
