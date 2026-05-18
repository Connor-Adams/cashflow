# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement light/dark theme system with Wander DS integration and vibrant accent colors for professional UI polish.

**Architecture:** React Context manages theme state (dark/light), CSS custom properties switch color palettes based on `[data-theme]` attribute on root. localStorage persists user choice. Gradual migration to Wander DS components; custom UI stays functional during transition.

**Tech Stack:** React, TailwindCSS, Wander DS, CSS custom properties

---

### Task 1: Create Theme Context and Hook

**Files:**
- Create: `frontend/src/contexts/ThemeContext.tsx`
- Create: `frontend/src/hooks/useTheme.ts`

- [ ] **Step 1: Write ThemeContext**

```typescript
// frontend/src/contexts/ThemeContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

interface ThemeContextType {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    // Check localStorage first
    const stored = localStorage.getItem('cashflow-theme')
    if (stored === 'light' || stored === 'dark') return stored
    // Fall back to system preference
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('cashflow-theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
```

- [ ] **Step 2: Write useTheme hook**

```typescript
// frontend/src/hooks/useTheme.ts
export { useTheme } from '../contexts/ThemeContext'
```

- [ ] **Step 3: Run type check**

```bash
cd frontend && npm run build 2>&1 | grep -i error
```

Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/contexts/ThemeContext.tsx frontend/src/hooks/useTheme.ts
git commit -m "feat: create theme context and hook"
```

---

### Task 2: Add Theme Provider to App

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update App.tsx to wrap with ThemeProvider**

```typescript
// frontend/src/App.tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { Layout } from './components/Layout'
import { AccountsPage } from './pages/AccountsPage'
import { DashboardPage } from './pages/DashboardPage'
import { ReportsPage } from './pages/ReportsPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { ReviewInboxPage } from './pages/ReviewInboxPage'
import { RulesPage } from './pages/RulesPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { AmazonPage } from './pages/AmazonPage'
import { AuthPage } from './pages/AuthPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthProvider } from './lib/auth'
import { useAuth } from './lib/useAuth'
import './App.css'

function AppRoutes() {
  const auth = useAuth()
  if (auth.loading) {
    return <main className="authShell"><p className="muted">Loading...</p></main>
  }
  if (!auth.user) return <AuthPage />
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="review" element={<ReviewInboxPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="amazon" element={<AmazonPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  )
}
```

- [ ] **Step 2: Run type check**

```bash
cd frontend && npm run build 2>&1 | grep -i error
```

Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: wrap app with ThemeProvider"
```

---

### Task 3: Add Theme Toggle to Layout Header

**Files:**
- Modify: `frontend/src/components/Layout.tsx`

- [ ] **Step 1: Add theme toggle button**

Find the header section in Layout.tsx and add a toggle button. Here's the pattern to add in the userMenu:

```typescript
// In the header/userMenu section of Layout.tsx, add:
import { useTheme } from '../hooks/useTheme'
import { Sun, Moon } from 'lucide-react'

// Inside the component:
const { theme, toggleTheme } = useTheme()

// In the header JSX, add before the logout button:
<button
  onClick={toggleTheme}
  className="p-2 rounded-lg transition-colors hover:bg-opacity-10 hover:bg-primary"
  title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
  aria-label="Toggle theme"
>
  {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
</button>
```

- [ ] **Step 2: Run dev server and check it works**

```bash
cd frontend && npm run dev &
sleep 3
# Navigate to localhost:5173 and verify the sun/moon icon appears in header
```

Expected: Icon visible in header, clicking it toggles the data-theme attribute (inspect with dev tools)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Layout.tsx
git commit -m "feat: add theme toggle button to header"
```

---

### Task 4: Define Color Palette with Light/Dark Variants

**Files:**
- Create: `frontend/src/theme/colors.ts`

- [ ] **Step 1: Write color palette**

```typescript
// frontend/src/theme/colors.ts
export const colorPalette = {
  dark: {
    // Backgrounds
    background: '#0f0f0f',
    bg: '#1a1a1a',
    bg2: '#242424',
    bg3: '#2d2d2d',
    card: '#1e1e1e',
    
    // Text
    fg: '#f0f0f0',
    'muted-foreground': '#a0a0a0',
    muted: '#707070',
    
    // Accents
    primary: '#3b82f6', // Electric blue
    'primary-foreground': '#ffffff',
    accent: '#8b5cf6', // Vibrant purple
    'accent-soft': '#fbbf24', // Warm amber
    'accent-warm': '#f97316', // Warm orange
    'accent-green': '#10b981', // Vibrant green
    
    // Semantic
    border: '#333333',
    danger: '#ef4444',
    shadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
  },
  light: {
    // Backgrounds
    background: '#ffffff',
    bg: '#f9f9f9',
    bg2: '#f3f3f3',
    bg3: '#e8e8e8',
    card: '#fafafa',
    
    // Text
    fg: '#1f1f1f',
    'muted-foreground': '#555555',
    muted: '#808080',
    
    // Accents (toned down for light mode)
    primary: '#2563eb', // Deeper blue
    'primary-foreground': '#ffffff',
    accent: '#7c3aed', // Deeper purple
    'accent-soft': '#d97706', // Deeper amber
    'accent-warm': '#ea580c', // Deeper orange
    'accent-green': '#059669', // Deeper green
    
    // Semantic
    border: '#d0d0d0',
    danger: '#dc2626',
    shadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
  },
}
```

- [ ] **Step 2: Run type check**

```bash
cd frontend && npm run build 2>&1 | grep -i error
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/theme/colors.ts
git commit -m "feat: define vibrant color palette for dark and light themes"
```

---

### Task 5: Update App.css with Theme Variables

**Files:**
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Replace the top of App.css with new theme setup**

Replace the `@reference "./index.css";` and the `@layer base` section with:

```css
@reference "./index.css";

/* Theme variables - will be set by ThemeContext */
:root[data-theme="dark"] {
  --background: #0f0f0f;
  --bg: #1a1a1a;
  --bg2: #242424;
  --bg3: #2d2d2d;
  --card: #1e1e1e;
  --fg: #f0f0f0;
  --muted-foreground: #a0a0a0;
  --muted: #707070;
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  --accent: #8b5cf6;
  --accent-soft: #fbbf24;
  --accent-warm: #f97316;
  --accent-green: #10b981;
  --border: #333333;
  --danger: #ef4444;
  --shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
}

:root[data-theme="light"] {
  --background: #ffffff;
  --bg: #f9f9f9;
  --bg2: #f3f3f3;
  --bg3: #e8e8e8;
  --card: #fafafa;
  --fg: #1f1f1f;
  --muted-foreground: #555555;
  --muted: #808080;
  --primary: #2563eb;
  --primary-foreground: #ffffff;
  --accent: #7c3aed;
  --accent-soft: #d97706;
  --accent-warm: #ea580c;
  --accent-green: #059669;
  --border: #d0d0d0;
  --danger: #dc2626;
  --shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

@layer base {
  /* Legacy fallback while older pages migrate to local ui primitives. */
  button:not([data-slot]) {
    @apply inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition-colors duration-150;
    border-color: var(--border);
    background: color-mix(in srgb, var(--bg2) 88%, black 4%);
    color: var(--fg);
  }

  button:not([data-slot]):hover:enabled {
    background: color-mix(in srgb, var(--bg3) 88%, white 4%);
    border-color: color-mix(in srgb, var(--primary) 24%, var(--border));
  }

  button:not([data-slot]):disabled {
    @apply cursor-not-allowed opacity-50;
  }

  button:not([data-slot]).btnDanger {
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
    color: var(--danger);
  }

  input:not([data-slot]),
  select:not([data-slot]),
  textarea:not([data-slot]) {
    @apply min-h-10 rounded-lg border px-3 py-2 text-sm transition-colors duration-150 outline-none;
    border-color: var(--border);
    background: color-mix(in srgb, var(--bg) 90%, black 4%);
    color: var(--fg);
  }

  input:not([data-slot]):focus,
  select:not([data-slot]):focus,
  textarea:not([data-slot]):focus {
    border-color: color-mix(in srgb, var(--primary) 62%, white 10%);
    box-shadow: 0 0 0 3px rgba(119, 167, 255, 0.18);
  }

  input:not([data-slot])[aria-invalid='true'],
  select:not([data-slot])[aria-invalid='true'],
  textarea:not([data-slot])[aria-invalid='true'] {
    border-color: color-mix(in srgb, var(--danger) 62%, var(--border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 16%, transparent);
  }
}

/* Keep all the @layer components unchanged - they already use var(--*) */
```

Then keep the rest of the file as-is (all the `@layer components` sections already use `var(--*)` so they'll automatically switch).

- [ ] **Step 2: Run dev server and verify theme switching works**

```bash
cd frontend && npm run dev &
sleep 3
# Navigate to localhost:5173
# Click the sun/moon icon in header
# Verify the page colors switch between dark and light
```

Expected: Page background, text, and accent colors smoothly switch when toggling theme

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.css
git commit -m "feat: add dark and light theme color variables"
```

---

### Task 6: Add Wander DS Dependencies and Update Button Component

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/components/ui/button.tsx`

- [ ] **Step 1: Add Wander DS packages**

```bash
cd frontend && npm install @wandercom/design-system-web @wandercom/design-system-tokens @wandercom/design-system-shared
```

- [ ] **Step 2: Update button.tsx to use Wander DS Button**

```typescript
// frontend/src/components/ui/button.tsx
import * as React from "react"
import { Button as WanderButton } from "@wandercom/design-system-web"
import { cn } from "@wandercom/design-system-shared"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "danger"
  size?: "default" | "sm" | "lg"
  asChild?: boolean
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
```

- [ ] **Step 3: Run type check**

```bash
cd frontend && npm run build 2>&1 | grep -i error
```

Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/src/components/ui/button.tsx
git commit -m "feat: integrate Wander DS and update button component"
```

---

### Task 7: Test Light/Dark Theme Switching on All Pages

**Files:**
- No files modified; verification only

- [ ] **Step 1: Start dev server**

```bash
cd frontend && npm run dev &
sleep 3
```

- [ ] **Step 2: Test dark theme (default)**

Navigate to `http://localhost:5173` and verify:
- Background is dark (#0f0f0f)
- Text is light (#f0f0f0)
- Primary buttons use electric blue (#3b82f6)
- Accent colors are vibrant (purple, orange, green)

- [ ] **Step 3: Toggle to light theme**

Click the sun icon in header and verify:
- Background is white (#ffffff)
- Text is dark (#1f1f1f)
- Primary buttons use deeper blue (#2563eb)
- All pages remain readable and styled correctly

- [ ] **Step 4: Test theme persistence**

Refresh the page and verify the theme remains as set.

- [ ] **Step 5: Test all pages**

Navigate through each page (Dashboard, Transactions, Accounts, Portfolio, Reports, Rules, Review, Amazon, Settings) in both themes. Verify no visual regressions.

- [ ] **Step 6: No new commits needed**

This is verification only. If issues found, create new tasks to fix them.
