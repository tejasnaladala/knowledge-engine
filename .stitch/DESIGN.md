# Knowledge Engine -- Design System

## 1. Atmosphere

**Product:** Personal AI knowledge engine dashboard. Ingests Instagram reels, extracts knowledge, builds a graph, and surfaces project recommendations.

**Density:** 5/10 -- Daily App Balanced. Enough information density to be useful, enough breathing room to feel calm.
**Variance:** 7/10 -- Offset Asymmetric. Avoids generic grid symmetry. Uses split layouts, varied card sizes, and deliberate whitespace imbalance.
**Motion:** 5/10 -- Fluid CSS. Purposeful transitions on interactions. No gratuitous animation.

**Mood:** Warm, focused, intelligent. Like a well-organized research notebook -- not a flashy SaaS dashboard.

## 2. Color Palette

| Name | Hex | Role |
|------|-----|------|
| Warm White | `#FAFAF8` | Page background |
| Canvas | `#FFFFFF` | Card surfaces |
| Stone-50 | `#F5F5F0` | Secondary surfaces, input backgrounds |
| Stone-200 | `#E7E5DF` | Borders, dividers |
| Stone-400 | `#A8A29D` | Tertiary text, placeholders |
| Stone-600 | `#78716C` | Secondary text |
| Stone-900 | `#1C1917` | Primary text (NOT pure black) |
| Teal-600 | `#0D9488` | Single accent color. CTAs, links, active states |
| Teal-50 | `#F0FDFA` | Accent tint for backgrounds |
| Teal-800 | `#115E59` | Accent dark for hover states |
| Rose-500 | `#F43F5E` | Error, danger, high-hype indicator |
| Amber-500 | `#F59E0B` | Warning, moderate-hype indicator |
| Emerald-500 | `#10B981` | Success, grounded indicator, live status |

**Entity type colors (muted, professional):**
| Type | Color | Hex |
|------|-------|-----|
| repository | Teal | `#0D9488` |
| tool | Amber | `#D97706` |
| model | Rose | `#E11D48` |
| library | Sky | `#0284C7` |
| framework | Violet | `#7C3AED` |
| person | Slate | `#64748B` |
| company | Cyan | `#0891B2` |
| technique | Emerald | `#059669` |
| workflow | Orange | `#EA580C` |
| architecture | Pink | `#DB2777` |

**BANNED:** Purple/blue neon gradients. Pure black (#000000). Oversaturated accents. Neon outer glows.

## 3. Typography

**Primary:** `Satoshi`, system-ui, -apple-system, sans-serif
**Monospace:** `JetBrains Mono`, `SF Mono`, `Fira Code`, monospace

| Level | Size | Weight | Tracking | Usage |
|-------|------|--------|----------|-------|
| Display | clamp(28px, 4vw, 36px) | 700 | -0.025em | Page title only |
| H2 | 20px | 600 | -0.015em | Section headers |
| H3 | 16px | 600 | -0.01em | Card titles |
| Body | 15px | 400 | 0 | Default text |
| Small | 13px | 500 | 0.01em | Meta text, badges, timestamps |
| Tiny | 11px | 600 | 0.03em | Overline labels, uppercase categories |

**Line heights:** Display 1.15, Body 1.6, Small 1.4
**Max line width:** 65ch for body text

**BANNED:** Inter font. Generic serifs. Font sizes below 11px.

## 4. Layout Principles

- **Max-width:** 1100px centered with `clamp(16px, 3vw, 32px)` side padding
- **Section gaps:** 40px between major sections
- **Card padding:** 24px standard, 32px for hero elements
- **No centered hero** -- left-aligned with asymmetric whitespace
- **No 3-equal-cards** -- use 2-column zig-zag or asymmetric grid
- **Grid:** CSS Grid, not flexbox hacks
- **Stats row:** 4 cards but with varied visual weight (first card larger or accented)

## 5. Component Styles

**Cards:**
- Background: Canvas (#FFFFFF)
- Border: 1px solid Stone-200
- Border-radius: 16px
- Shadow: none by default. On hover: `0 2px 8px rgba(28,25,23,0.06)`
- No elevation stacking

**Buttons:**
- Primary: Teal-600 bg, white text, 10px 20px padding, 8px radius
- Hover: Teal-800 bg, translateY(-1px)
- Active: scale(0.98) for tactile feel
- No outer glows

**Inputs:**
- Stone-50 background, Stone-200 border
- 44px height minimum (touch target)
- Focus: Teal-600 border, `0 0 0 3px rgba(13,148,136,0.1)` ring
- 16px font size (prevents iOS zoom)

**Badges:**
- 6px 12px padding, 6px radius (not fully rounded pills -- more squared)
- 11px font, 600 weight, uppercase
- Muted bg + saturated text per entity type

**Empty states:**
- Left-aligned, not centered
- Illustration: simple SVG or single-character symbol
- Instructional text with code snippet for CLI usage

## 6. Motion

- **Transitions:** 150ms ease-out for hover states
- **Page load:** Cards fade in with 20px upward translate, staggered 60ms
- **Modal:** Backdrop opacity 0→0.3, card scale 0.97→1, 200ms
- **Graph nodes:** Smooth 30fps physics, settles within 3 seconds
- **Feed items:** slideDown 12px + fadeIn, 200ms

**BANNED:** Linear easing. Bounce effects. Infinite spinners (use skeleton loaders). Animation on layout properties (top, left, width, height).

## 7. Anti-Patterns (NEVER DO)

- No emojis in the UI
- No Inter font
- No pure black (#000000)
- No neon/outer glow shadows
- No 3-column equal card layouts
- No centered hero sections
- No AI copywriting cliches ("Elevate", "Seamless", "Unleash")
- No fake data or fabricated statistics
- No custom mouse cursors
- No overlapping elements
- No horizontal scroll on mobile
- No generic serif fonts
- No oversaturated gradients
- No filler text ("Scroll to explore", bouncing chevrons)
