# Story 1.2: Design System Foundation

Status: ready-for-dev

## Story

As a **developer**,
I want the Hex-inspired dark theme design system implemented with all tokens, customized Shadcn/ui components, and foundational CSS utilities,
so that all subsequent UI work uses a consistent, polished visual foundation.

## Acceptance Criteria

**Given** the project is scaffolded (Story 1.1 complete)
**When** the design system is implemented
**Then** `tailwind.config.ts` defines the complete color token system: `background: #14141C`, `foreground: #e3e1e4`, `card: #1c1c26`, `popover: #22222e`, `primary: #A477B2`, `secondary: #F5C0C0`, `muted: #2a2a36`, `muted-foreground: #8a8694`, `accent: #3a3a48`, `border: #333340`, `destructive: #e55b5b`, `success: #5bc27a`, `warning: #e5a93b`, `info: #6ba3e8`
**And** semantic classification badge colors are defined: PII (`rgba(229,91,91,0.15)` bg / `#e55b5b` text), SENSITIVE (`rgba(229,169,59,0.15)` bg / `#e5a93b` text), INTERNAL (`rgba(107,163,232,0.15)` bg / `#6ba3e8` text), PUBLIC (`rgba(91,194,122,0.15)` bg / `#5bc27a` text)
**And** typography uses Inter/system-ui for UI text and JetBrains Mono/Fira Code for code/data elements, with the defined type scale (display 28px through mono-small 12px)
**And** spacing tokens are defined on 4px base unit (`space-1` through `space-10`)
**And** the depth/surface system is implemented with 5 layers: Base (#14141C), Surface 1 (#1c1c26 + shadow), Surface 2 (#22222e + deeper shadow), Glass (rgba with backdrop-blur 12px), Overlay (rgba with blur 4px)
**And** CSS custom properties exist for `--glass-bg`, `--glass-blur`, `--gradient-border`, `--field-complete`, `--field-suggestion`, `--field-error`, `--mono-size`, `--transition-spring`
**And** border-radius defaults to 12px globally
**And** micro-animation CSS utilities exist: panel expand (200ms ease-out), field hover (150ms ease-in-out), validation ring (300ms spring), toast slide-in (250ms spring), tab switch (150ms ease-in-out), with `prefers-reduced-motion` respected
**And** all 14 Shadcn/ui components (DataTable, Command, Tabs, Sheet, Popover, Select/Combobox, Badge, Toast, Dialog, Form, Tooltip, Accordion, DropdownMenu, Input) are customized with dark theme tokens, 12px border-radius, and frosted glass treatment where specified
**And** a unit test verifies that all color tokens are correctly defined in the Tailwind config
**And** a visual test page exists at `/dev/design-system` (dev-only route) that renders all customized Shadcn/ui components, badges, surfaces, and typography for visual verification

## Tasks / Subtasks

- [ ] **Configure Tailwind color token system in `tailwind.config.ts`**
  - Define all primary palette colors:
    - `background: '#14141C'` (obsidian base)
    - `foreground: '#e3e1e4'` (warm light text)
    - `card: '#1c1c26'` (elevated surfaces)
    - `popover: '#22222e'` (panel surfaces)
    - `primary: '#A477B2'` (amethyst accent)
    - `secondary: '#F5C0C0'` (rose-quartz)
    - `muted: '#2a2a36'` (subtle backgrounds)
    - `muted-foreground: '#8a8694'` (secondary text)
    - `accent: '#3a3a48'` (hover states)
    - `border: '#333340'` (subtle dividers)
    - `destructive: '#e55b5b'` (warm red)
    - `success: '#5bc27a'` (validation green)
    - `warning: '#e5a93b'` (warm amber)
    - `info: '#6ba3e8'` (informational blue)

- [ ] **Define semantic classification badge color tokens**
  - Create badge color variants in Tailwind config or as CSS classes:
    - PII: bg `rgba(229, 91, 91, 0.15)`, text `#e55b5b`
    - SENSITIVE: bg `rgba(229, 169, 59, 0.15)`, text `#e5a93b`
    - INTERNAL: bg `rgba(107, 163, 232, 0.15)`, text `#6ba3e8`
    - PUBLIC: bg `rgba(91, 194, 122, 0.15)`, text `#5bc27a`

- [ ] **Configure typography system**
  - Add font families to `tailwind.config.ts`:
    - `sans: ['Inter', 'system-ui', 'sans-serif']` (UI elements)
    - `mono: ['JetBrains Mono', 'Fira Code', 'monospace']` (code, data, field names)
  - Add `@fontsource/inter` and `@fontsource/jetbrains-mono` packages or configure via `next/font`
  - Define type scale as Tailwind utilities or CSS custom properties:
    - `display`: 28px, weight 600, line-height 1.2, letter-spacing -0.01em
    - `heading-1`: 22px, weight 600, line-height 1.3
    - `heading-2`: 18px, weight 500, line-height 1.35
    - `heading-3`: 15px, weight 500, line-height 1.4
    - `body`: 14px, weight 400, line-height 1.5
    - `body-small`: 13px, weight 400, line-height 1.5
    - `caption`: 11px, weight 500, line-height 1.4, letter-spacing +0.02em
    - `mono`: 13px, weight 400, line-height 1.6
    - `mono-small`: 12px, weight 400, line-height 1.5

- [ ] **Define spacing tokens on 4px base unit**
  - Add to `tailwind.config.ts` extend spacing:
    - `space-1: '4px'`
    - `space-2: '8px'`
    - `space-3: '12px'`
    - `space-4: '16px'`
    - `space-6: '24px'`
    - `space-8: '32px'`
    - `space-10: '40px'`

- [ ] **Implement depth/surface system**
  - Define 5 surface layers as CSS classes or Tailwind utilities:
    - **Base**: `#14141C`, no shadow, no blur
    - **Surface 1**: `#1c1c26`, shadow `0 1px 3px rgba(0,0,0,0.3)` -- cards, sidebar
    - **Surface 2**: `#22222e`, shadow `0 4px 12px rgba(0,0,0,0.4)` -- popovers, dropdowns
    - **Glass**: `rgba(28,28,38,0.8)`, shadow `inset 0 0 11px rgba(0,0,0,0.05)`, `backdrop-filter: blur(12px)` -- top bar, right panel
    - **Overlay**: `rgba(0,0,0,0.6)`, `backdrop-filter: blur(4px)` -- modal backdrop
  - Create utility classes: `.surface-base`, `.surface-1`, `.surface-2`, `.surface-glass`, `.surface-overlay`

- [ ] **Define CSS custom properties in global CSS (`src/app/globals.css`)**
  - `--glass-bg: rgba(28, 28, 38, 0.8)`
  - `--glass-blur: blur(12px)`
  - `--gradient-border: linear-gradient(135deg, #A477B2, #F5C0C0)`
  - `--field-complete: #5bc27a` (maps to success)
  - `--field-suggestion: #e5a93b` (maps to warning)
  - `--field-error: #e55b5b` (maps to destructive)
  - `--mono-size: 13px`
  - `--transition-spring: cubic-bezier(0.34, 1.56, 0.64, 1)`

- [ ] **Set global border-radius default to 12px**
  - In `tailwind.config.ts`, set `borderRadius.DEFAULT: '12px'`
  - Ensure Shadcn/ui components inherit this default

- [ ] **Create micro-animation CSS utilities**
  - Define animation utilities in `globals.css` or as Tailwind plugin:
    - `.animate-panel-expand`: `transition: all 200ms ease-out`
    - `.animate-field-hover`: `transition: all 150ms ease-in-out`
    - `.animate-validation-ring`: `transition: all 300ms cubic-bezier(0.34, 1.56, 0.64, 1)` (spring)
    - `.animate-toast-slide`: `animation: slide-in 250ms cubic-bezier(0.34, 1.56, 0.64, 1)`
    - `.animate-tab-switch`: `transition: all 150ms ease-in-out`
    - `.animate-tile-toggle`: `transition: all 300ms ease-out`
    - `.animate-badge-appear`: `animation: badge-pop 200ms cubic-bezier(0.34, 1.56, 0.64, 1)`
  - Add `@keyframes slide-in` and `@keyframes badge-pop` definitions
  - Add `prefers-reduced-motion` media query:
    ```css
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
    ```

- [ ] **Install and customize all 14 Shadcn/ui components**
  - Run `npx shadcn@latest add` for each component:
    - `data-table` (or `table` + custom DataTable wrapper)
    - `command`
    - `tabs`
    - `sheet`
    - `popover`
    - `select`
    - `badge`
    - `toast` (or `sonner`)
    - `dialog`
    - `form`
    - `tooltip`
    - `accordion`
    - `dropdown-menu`
    - `input`
  - Customize each component in `src/components/ui/`:
    - Apply dark theme color tokens (background, foreground, border)
    - Set border-radius to 12px
    - Apply frosted glass treatment (backdrop-blur, semi-transparent bg) to: Sheet, Popover, Dialog overlay, Toast, Command palette
    - Ensure all use `cn()` utility for className merging

- [ ] **Create unit test for color tokens**
  - Create `tests/unit/design-system.test.ts`
  - Import or read `tailwind.config.ts` and verify:
    - All 14 color tokens are defined with correct hex values
    - Classification badge colors are defined
    - Font families include Inter and JetBrains Mono
    - Spacing tokens space-1 through space-10 exist
    - Border-radius default is 12px

- [ ] **Create visual test page at `/dev/design-system`**
  - Create `src/app/dev/design-system/page.tsx` (dev-only route)
  - Render sections demonstrating:
    - All color swatches with token names and hex values
    - All 5 surface layers (Base, Surface 1, Surface 2, Glass, Overlay)
    - Typography scale (display through mono-small)
    - Spacing token visualization
    - Classification badges (PII, SENSITIVE, INTERNAL, PUBLIC)
    - All 14 customized Shadcn/ui components with sample content
    - Micro-animation demonstrations (hover, click interactions)
  - Gate this route to development environment only (`process.env.NODE_ENV === 'development'`)

## Dev Notes

### Architecture & Patterns
- **Tailwind CSS 4.x**: All design tokens defined in `tailwind.config.ts` -- this is the single source of truth for colors, spacing, typography, and border-radius.
- **Shadcn/ui**: Components are copied into `src/components/ui/` (not npm imports). Full ownership for customization. Built on Radix UI accessible primitives.
- **CSS custom properties**: Bridge between Tailwind tokens and component-level styling. Used for dynamic values like `--glass-bg` and `--transition-spring`.
- **No pure black or pure white**: The color palette uses warm tones (#14141C for dark, #e3e1e4 for light). This is a deliberate Hex-inspired design choice.
- **Component pattern**: Each Shadcn component lives in `src/components/ui/{component}.tsx`. Custom components follow the pattern with separate `.types.ts` and hook files.

### UX/Design Requirements

**Color System (UX-DR1, UX-DR25):**
| Token | Hex | Usage |
|-------|-----|-------|
| `background` | `#14141C` | Page background, obsidian base |
| `foreground` | `#e3e1e4` | Primary text, warm light |
| `card` | `#1c1c26` | Elevated surfaces, entity cards, panels |
| `popover` | `#22222e` | Popovers, dropdowns, command palette |
| `primary` | `#A477B2` | Primary actions, active states, amethyst accent |
| `secondary` | `#F5C0C0` | Secondary accent, rose-quartz highlights |
| `muted` | `#2a2a36` | Subtle backgrounds, inactive tabs, disabled states |
| `muted-foreground` | `#8a8694` | Secondary text, labels, placeholders |
| `accent` | `#3a3a48` | Hover states, selected rows |
| `border` | `#333340` | Subtle dividers, panel edges |
| `destructive` | `#e55b5b` | Missing required metadata, breaking changes |
| `success` | `#5bc27a` | Valid fields, passed validation |
| `warning` | `#e5a93b` | Suggestions pending, lossy mappings |
| `info` | `#6ba3e8` | Informational tooltips, links |

**Classification Badge Colors (UX-DR30):**
| Classification | Background | Text |
|----------------|------------|------|
| PII | `rgba(229, 91, 91, 0.15)` | `#e55b5b` |
| SENSITIVE | `rgba(229, 169, 59, 0.15)` | `#e5a93b` |
| INTERNAL | `rgba(107, 163, 232, 0.15)` | `#6ba3e8` |
| PUBLIC | `rgba(91, 194, 122, 0.15)` | `#5bc27a` |

**Typography (UX-DR26):**
- UI font: Inter / system-ui fallback
- Code font: JetBrains Mono / Fira Code fallback
- Type scale: display (28px/600), heading-1 (22px/600), heading-2 (18px/500), heading-3 (15px/500), body (14px/400), body-small (13px/400), caption (11px/500), mono (13px/400), mono-small (12px/400)
- Letter-spacing: -0.01em on display, +0.02em on captions

**Spacing (UX-DR27):**
- 4px base unit: space-1 (4px), space-2 (8px), space-3 (12px), space-4 (16px), space-6 (24px), space-8 (32px), space-10 (40px)

**Depth/Surfaces (UX-DR2, UX-DR28):**
- Base: `#14141C`, no effects
- Surface 1: `#1c1c26`, shadow `0 1px 3px rgba(0,0,0,0.3)` -- cards, sidebar
- Surface 2: `#22222e`, shadow `0 4px 12px rgba(0,0,0,0.4)` -- popovers
- Glass: `rgba(28,28,38,0.8)`, inset shadow, `backdrop-filter: blur(12px)` -- top bar, right panel
- Overlay: `rgba(0,0,0,0.6)`, `backdrop-filter: blur(4px)` -- modal backdrop

**Custom Design Tokens:**
- `--glass-bg`: `rgba(28, 28, 38, 0.8)`
- `--glass-blur`: `backdrop-filter: blur(12px)`
- `--gradient-border`: `linear-gradient(135deg, #A477B2, #F5C0C0)`
- `--field-complete`: `#5bc27a`
- `--field-suggestion`: `#e5a93b`
- `--field-error`: `#e55b5b`
- `--mono-size`: `13px`
- `--transition-spring`: `cubic-bezier(0.34, 1.56, 0.64, 1)`

**Borders:** 1px solid `#333340` for dividers. Active elements get gradient border. No borders on buttons -- background shift for hover. Border-radius: 12px globally.

**Micro-Animations (UX-DR29):**
| Interaction | Duration | Easing |
|-------------|----------|--------|
| Panel expand/collapse | 200ms | ease-out |
| Field row hover | 150ms | ease-in-out |
| Validation ring appear | 300ms | spring (cubic-bezier(0.34, 1.56, 0.64, 1)) |
| Toast slide-in | 250ms | spring |
| Tab switch | 150ms | ease-in-out |
| Tile/list toggle | 300ms | ease-out |
| Badge appear | 200ms | spring |
All animations respect `prefers-reduced-motion`.

**Contrast:** foreground on background = 12.8:1 (WCAG AAA). muted-foreground on background = 5.2:1 (WCAG AA).

### File Structure
Files this story creates or modifies:

```
src/
├── app/
│   ├── globals.css                    # CSS custom properties, surface utilities, animations
│   ├── layout.tsx                     # Font imports (Inter, JetBrains Mono)
│   └── dev/
│       └── design-system/
│           └── page.tsx               # Visual test page (dev-only)
├── components/ui/
│   ├── badge.tsx                      # Customized with classification variants
│   ├── command.tsx                    # Customized with frosted glass
│   ├── tabs.tsx                       # Customized with pill style
│   ├── sheet.tsx                      # Customized with frosted glass
│   ├── popover.tsx                    # Customized with frosted glass
│   ├── select.tsx                     # Customized with dark theme
│   ├── toast.tsx (or sonner.tsx)      # Customized with frosted glass
│   ├── dialog.tsx                     # Customized with overlay
│   ├── form.tsx                       # Customized with dark theme
│   ├── tooltip.tsx                    # Customized with dark theme
│   ├── accordion.tsx                  # Customized with dark theme
│   ├── dropdown-menu.tsx              # Customized with dark theme
│   ├── input.tsx                      # Customized with dark theme
│   └── data-table.tsx                 # Custom DataTable component
tailwind.config.ts                     # Color tokens, typography, spacing, border-radius
tests/unit/design-system.test.ts       # Token verification test
```

### Testing Requirements
- **Unit test**: `tests/unit/design-system.test.ts` -- verify all color tokens, spacing tokens, font families, and border-radius are correctly defined in Tailwind config
- **Visual verification**: `/dev/design-system` page for manual visual review of all components
- No E2E tests required for this story

### Dependencies & Prerequisites
- **Prerequisites**: Story 1.1 (Project Scaffolding) must be complete
- **Enables**: Story 1.3 (Application Shell & IDE Layout) -- the shell uses the design tokens and components defined here
- All subsequent UI stories depend on this design system

### References
- [Source: epics.md - Epic 1, Story 1.2]
- [Source: ux-design-specification.md - Design System Foundation]
- [Source: ux-design-specification.md - Visual Design Foundation / Color System]
- [Source: ux-design-specification.md - Typography System]
- [Source: ux-design-specification.md - Spacing & Layout Foundation]
- [Source: ux-design-specification.md - Depth & Surface System]
- [Source: ux-design-specification.md - Micro-Animation System]
- [Source: architecture.md - Starter Template (Shadcn/ui + Tailwind CSS)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
