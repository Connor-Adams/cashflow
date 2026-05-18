import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium outline-offset-2 transition-colors focus-visible:outline-1 focus-visible:outline-button-primary disabled:pointer-events-none disabled:opacity-30 aria-invalid:outline-destructive [&_svg:not([class*='size-'])]:size-5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: 'bg-button-primary',
        secondary: 'bg-button-secondary text-primary',
        outline: 'border border-secondary bg-button-outline text-primary',
        ghost: 'bg-button-ghost text-primary',
        destructive: 'bg-button-destructive text-destructive focus-visible:outline-destructive',
        checkout: 'bg-button-checkout text-white',
        link: 'h-auto rounded-none bg-transparent p-0! font-normal! text-blue-500 text-body! underline-offset-4 hover:underline hover:text-blue-600',
        unstyled: 'touch-hitbox h-auto bg-transparent p-0!',
      },
      size: {
        sm: 'h-8 px-3 text-body has-[>svg]:pl-2',
        md: 'h-10 px-4 text-body has-[>svg]:pl-3',
        lg: 'h-12 px-5 text-body-lg has-[>svg]:pl-4 [&_svg:not([class*="size-"])]:size-5!',
        'icon-sm': 'size-8',
        'icon-md': 'size-10',
        'icon-lg': 'size-12 [&_svg:not([class*="size-"])]:size-5!',
      },
    },
    compoundVariants: [
      {
        variant: 'link',
        size: ['sm', 'md', 'lg', 'icon-sm', 'icon-md', 'icon-lg'],
        className: 'h-auto',
      },
      {
        variant: 'unstyled',
        size: ['sm', 'md', 'lg', 'icon-sm', 'icon-md', 'icon-lg'],
        className: 'h-auto',
      },
    ],
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      data-slot="button"
      {...props}
    />
  )
}

export { Button }
