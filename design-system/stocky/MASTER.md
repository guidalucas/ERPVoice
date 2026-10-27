# Stocky Design System

Override of UI UX Pro Max generic output. Brand identity (cyan → blue → violet soundwave) wins over the teal/orange/Inter suggestion.

## Design Read

Redesign-overhaul of a voice-first inventory ERP for daily operators across commerce types. Premium dark-tech language, not a landing page.

## Dials

- Variance: 6/10 — break equal KPI cards and the centered shell; keep a work-tool grid
- Motion: 4/10 — hover, filter, section change only; honor `prefers-reduced-motion`
- Density: 7/10 — medium-high dashboard, not a cockpit and not a marketing page

## Tokens

| Role | Dark | Light |
|------|------|-------|
| Background | `#07070b` | `#f4f4f8` |
| Surface | `#101018` | `#ffffff` |
| Elevated | `#181822` | `#f7f7fb` |
| Text | `#f4f4f8` | `#12121a` |
| Muted | `#b0b0c0` | `#5c5c70` |
| Accent | `#2dd4e8` | `#0e7490` |
| Accent 2 | `#8b5cf6` | `#6d28d9` |
| Brand gradient | `#2dd4e8 → #3b82f6 → #8b5cf6` | same, slightly deeper |
| Warning | `#f5b94f` | `#b45309` |
| Destructive | `#fb7185` | `#e11d48` |

Muted text is calibrated for WCAG AA on both surfaces (≥4.5:1).

## Typography

- Family: Outfit (rounded geometric sans, matches the Stocky wordmark)
- Titles: 700 / tracking -0.03em
- Metrics: 800 / tabular-nums / tracking -0.04em
- Body: 400–500
- Do not use Inter

## Shape

- App chrome: flush (0)
- Panels: 20px
- Rows / inputs: 14px
- Buttons and chips: pill
- Avatars: 12px squircle

## Layout

- Full-bleed app. No centered max-width card wrapping the whole dashboard
- Desktop sidebar 240px, content uses remaining width
- Mobile: bottom tab bar (Inicio, Inventario, Pedidos, Actividad + Más)
- KPI bento: featured metric + alert cards, not four identical tiles
- Touch targets ≥ 44px

## Motion

- Duration 180–240ms, easing `cubic-bezier(0.16, 1, 0.3, 1)`
- Animate transform/opacity only
- No GSAP, no scroll hijack
