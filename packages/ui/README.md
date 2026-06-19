# @cashflow/ui

The Cashflow design system — a portable, self-contained component library providing
tokens, primitives, and utilities for building Cashflow product UI. Shipped as a
pre-built package; no Tailwind config required in consuming apps.

## Brand & Voice

Cashflow's visual identity is built on two pillars:

- **Oxblood (`#9B2D3A`) is the signature color.** A deep wine red used for brand,
  CTAs, money-out, and danger-adjacent contexts. Restrained, serious, "money you
  respect."
- **Greyscale (zinc) is the workhorse.** Most surfaces, borders, and text are zinc.
  Color is used sparingly and only where it carries meaning.

Money semantics are load-bearing: **green = money-in / positive**, **oxblood =
money-out / negative**. Never use them decoratively.

---

## Install

```bash
yarn add @cashflow/ui
```

### Peer dependencies

Install these alongside the package — they are declared as `peerDependencies` and
are not bundled:

| Package | Version |
|---|---|
| `react` | `^19.2.4` |
| `react-dom` | `^19.2.4` |
| `@radix-ui/react-slot` | `^1.2.4` |
| `lucide-react` | `^1.14.0` |

---

## Styling

Import **one** of the two CSS entry points at your app root. Choose based on your
build setup.

### Option A — compiled, self-contained (recommended for most consumers)

```ts
// app entry — e.g. main.tsx or _app.tsx
import '@cashflow/ui/styles.css';
```

`styles.css` is a pre-built, minified stylesheet that includes all design tokens
and component styles. It works in any build tool without Tailwind installed. This
is the right choice unless you are already running Tailwind v4 and want to
generate utilities yourself.

### Option B — source `@theme` (Tailwind v4 consumers only)

```css
/* your-app.css */
@import '@cashflow/ui/theme.css';
```

`theme.css` is the raw Tailwind v4 `@theme` source that registers all CSS custom
properties as Tailwind design tokens. Use this if your app runs Tailwind v4 and
you want to generate utility classes from the same token set (e.g. `bg-primary`,
`text-muted-foreground`). You are responsible for running the Tailwind CLI; no
utilities are pre-generated in this file.

**Do not import both.** Pick one.

---

## Dark mode

Dark mode is toggled by setting `data-theme="dark"` on a root element (typically
`<html>` or `<body>`). All semantic tokens flip automatically — no separate
stylesheet needed.

```tsx
// Enable dark mode
document.documentElement.setAttribute('data-theme', 'dark');

// Or in JSX
<html data-theme="dark">
  <App />
</html>
```

Light mode is the default (no attribute required). To be explicit:
`data-theme="light"`.

---

## Usage

### Button

```tsx
import { Button } from '@cashflow/ui';
import '@cashflow/ui/styles.css'; // import once at app root

function SaveButton() {
  return (
    <Button variant="default" size="default" onClick={() => console.log('saved')}>
      Save changes
    </Button>
  );
}
```

**Variants:** `default` · `primary` · `secondary` · `outline` · `ghost` ·
`destructive` · `danger` · `link`

**Sizes:** `default` (h-10 px-4) · `sm` · `lg` · `icon` (h-10 w-10)

Button supports `asChild` via Radix Slot for rendering as a link or custom element:

```tsx
import { Button } from '@cashflow/ui';
import { Link } from 'react-router-dom';

<Button asChild variant="ghost">
  <Link to="/dashboard">Dashboard</Link>
</Button>
```

---

## Design rules (from the Cashflow system)

1. **Reach for a primitive first.** Button, Card, Badge, Alert, and the other
   exports cover most cases. Compose, don't reinvent.
2. **Use semantic tokens, never raw hex.** `bg-card`, `text-muted-foreground`,
   `border-border`, `text-positive`. This is what makes dark mode free.
3. **Respect money semantics.** Green = in/gain, oxblood = out/loss.
4. **Oxblood is precious.** Brand/CTA/primary only — don't paint surfaces with it.
5. **Greyscale by default.** Zinc surfaces, zinc text, color only where it carries
   meaning.
6. **Every interactive element gets a visible focus ring** (`ring-ring`) and a
   minimum 44 × 44 px touch target.
7. **Provide loading (Skeleton), empty (EmptyState), and error (Alert) states** for
   any data view — they are first-class, not afterthoughts.

---

## Available exports

```ts
// Components
export { Button, type ButtonProps } from '@cashflow/ui';
export { Badge, type BadgeProps } from '@cashflow/ui';
export { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@cashflow/ui';
export { Input } from '@cashflow/ui';
export { Label } from '@cashflow/ui';
export { Alert, AlertTitle, AlertDescription } from '@cashflow/ui';
export { Skeleton, SkeletonText, SkeletonRow } from '@cashflow/ui';
export { EmptyState, EmptyTableRow } from '@cashflow/ui';
export { Tabs, TabsList, TabsTrigger, TabsContent } from '@cashflow/ui';
export { LetterAvatar } from '@cashflow/ui';
export { PageHeader } from '@cashflow/ui';
export { SectionHeader } from '@cashflow/ui';
export { StatCard } from '@cashflow/ui';
export { MetricStat } from '@cashflow/ui';
export { DeltaBadge } from '@cashflow/ui';

// Utilities
export { cn } from '@cashflow/ui';

// CSS entry points (import in your app root, not as JS imports)
// '@cashflow/ui/styles.css' — compiled, self-contained
// '@cashflow/ui/theme.css'  — raw @theme source for Tailwind v4 consumers
```

---

## License

UNLICENSED — internal use only.
