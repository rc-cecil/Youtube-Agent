---
name: Shorts Studio
description: A focused workspace for turning original gameplay recordings into verified Shorts.
colors:
  primary: '#d3ef7a'
  background: '#111315'
  surface: '#191c1f'
  muted-surface: '#202428'
  border: '#2b3035'
  border-strong: '#454d55'
  foreground: '#f1f3ec'
  muted-foreground: '#a7afb5'
  chart-secondary: '#b8d0e0'
  destructive: '#ffaaaa'
  success: '#c7e694'
  warning: '#efca87'
typography:
  display:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '34px'
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: '-0.03em'
  title:
    fontFamily: 'Manrope Variable, sans-serif'
    fontSize: '16px'
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: '11px'
    fontWeight: 500
    lineHeight: 1.45
rounded:
  sm: '6px'
  control: '8px'
  panel: '12px'
  media: '16px'
spacing:
  xs: '8px'
  sm: '16px'
  md: '24px'
  lg: '32px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.background}'
    rounded: '{rounded.control}'
    padding: '10px 16px'
    height: '44px'
  button-outline:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.control}'
    padding: '10px 16px'
    height: '44px'
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.panel}'
    padding: '{spacing.md}'
  input:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.control}'
    padding: '11px 14px'
---

# Design System: Shorts Studio

## Overview

**Creative North Star: "The Source-Footage Desk"**

Shorts Studio feels like a calm production desk: dark graphite equipment surfaces, warm readable type, and one lime action signal. It is dense enough for active creator work without turning analytics, publishing, or media review into a decorative dashboard.

The supplied gaming video is the Dashboard's sole focal image. Operational routes keep imagery subordinate to evidence, state, and action. Familiar controls, honest unavailable states, and restrained motion let the workspace disappear into the task.

**Key Characteristics:**

- Graphite tonal layers separated by fine borders rather than shadows.
- Lime reserved for primary actions, current selection, and meaningful state.
- Compact metric rails, tabular numerals, and explicit data provenance.
- One responsive shell shared by capture, editorial, publishing, analytics, and revenue.

## Colors

The palette uses one high-contrast lime accent over a neutral graphite ramp, with cool ash text and restrained semantic status colors.

### Primary

- **Signal Lime:** Primary actions, selected navigation, focus rings, and the engaged-view series. Its rarity makes it directional rather than decorative.

### Neutral

- **Desk Graphite:** The page field and darkest control backgrounds.
- **Equipment Graphite:** Cards, sidebar, and primary workspace panels.
- **Raised Graphite:** Popovers, muted controls, and secondary surfaces.
- **Seam Graphite:** Dividers, card outlines, and row boundaries.
- **Warm Paper:** Primary copy and high-emphasis values.
- **Cool Ash:** Supporting labels, timestamps, and explanatory text.

### Named Rules

**The One Signal Rule.** Lime identifies action, selection, or live meaning; it never fills inactive decoration.

**The Truth Has a Label Rule.** Success, warning, failure, unavailable, estimated, and derived states always include words or structure in addition to hue.

## Typography

**Display Font:** Manrope Variable (with sans-serif fallback)

**Body Font:** Geist Variable (with sans-serif fallback)

**Character:** Manrope gives headings and metrics a compact, confident production voice. Geist keeps controls, metadata, tables, and long operational copy neutral and highly legible.

### Hierarchy

- **Display:** Semibold, tightly tracked Manrope for page headings; it steps down on narrow screens.
- **Title:** Medium-to-semibold Manrope for panel headings and ranked item emphasis.
- **Body:** Regular Geist for instructions and descriptions, usually kept within 65–75 characters where prose is continuous.
- **Label:** Compact Geist for metadata, statuses, chart keys, and control labels.
- **Metric:** Manrope with tabular numerals; scale communicates importance without display effects.

### Named Rules

**The Operate-Type Rule.** Controls and data labels stay fixed-size and compact; no fluid display typography enters task surfaces.

## Layout

Desktop uses a fixed 232px sidebar and a content area capped at 1512px. The sidebar narrows at 1180px. At 760px it becomes a horizontal, scrollable navigation row and page content stacks without page-level overflow.

Spacing follows the recorded 8/16/24/32px rhythm. Operational cards use 20–24px interior spacing; dense rows use 10–16px. Analytics begins with a seven-column metric rail, a bounded 320px trend, and two-column supporting panels. On mobile, metrics reflow to two columns, panels stack, controls remain reachable, and the trend contracts to 260px. The Dashboard retains exactly one media hero.

## Elevation & Depth

The system is flat by default. Depth comes from graphite value changes, one-pixel seams, and content hierarchy—not drop shadows, blur, glass, or simulated physical material. Real footage supplies dimensional depth inside media frames; a restrained scrim protects hero copy contrast.

**The Tonal-Layer Rule.** A surface earns separation through background value and border contrast before any shadow is considered.

## Shapes

Controls use compact 6–8px corners, panels use 12px corners, and major workspaces or media use 16px corners. Circular forms are reserved for avatars, status dots, chart markers, and workflow indicators. Borders remain fine and low-contrast; pills are appropriate only for short statuses and badges.

## Components

### Buttons

- **Shape:** Compact rounded controls with a 44px target in primary task flows.
- **Primary:** Signal Lime with Desk Graphite text; reserved for the next meaningful action.
- **Outline / Secondary:** Graphite surface with a visible seam and warm foreground text.
- **Hover / Focus:** Fast color feedback and a visible lime focus ring. Active presses may move by one pixel; disabled controls retain labels and reduce opacity.

### Chips and Tabs

- Status badges combine semantic text, a restrained tinted surface, and compact pill geometry.
- Tabs use familiar grouped or underline treatments. Analytics windows remain horizontally reachable; revenue attribution exposes Game, Event, Length, Slot, and Role.

### Cards and Containers

- Equipment Graphite, one-pixel seams, 12px corners, and no resting shadow.
- Headers separate from data with a border. Dense lists preserve consistent row rhythm.
- Analytics charts have a persistent series key and an equivalent disclosed data table.

### Inputs and Fields

- Dark transparent or Desk Graphite fill, visible input border, 8px corners, and compact padding.
- Lime focus rings are never removed. Invalid fields use destructive color plus message text; disabled fields remain readable.

### Navigation

- Desktop navigation is a quiet vertical rail; the active route uses Signal Lime with dark text.
- Mobile navigation becomes a horizontal scroll row while breadcrumbs and privacy state remain in the content header.

### Dashboard Media Hero

The supplied animated gaming footage appears only in the Dashboard hero, remains muted and pausable, and pauses off-screen. Reduced-motion or data-saving preferences prevent automatic source assignment.

### Analytics and Revenue

Metrics use tabular numerals and point-of-use provenance. Charts do not animate data changes. Missing report days remain blank; unavailable, provider-estimated, and locally derived money are explicitly distinct. Polling updates never flash or reorder with decorative motion.

## Do's and Don'ts

### Do

- **Do** preserve semantic tokens, visible focus, readable labels, and responsive source rows.
- **Do** keep operational hierarchy compact enough that the next decision remains nearby.
- **Do** provide textual and tabular alternatives for color-coded or plotted data.
- **Do** keep the supplied hero video separate from uploaded source media and preserve its provenance.
- **Do** limit motion to 150–250ms state feedback, explicit progress, and intentional disclosure; honor reduced motion and keyboard input.

### Don't

- **Don't** add another dashboard shell or hero to Analytics, Revenue, or future routes.
- **Don't** render retained Efferd references as product UI; they inform hierarchy only.
- **Don't** fabricate metrics, fill missing dates with zero, or enable Phase 8 processing through previews.
- **Don't** animate routine polling or chart refreshes, or make animation necessary to understand an action.
- **Don't** imitate glass, metal, bevels, or other physical materials with CSS effects.
