---
name: Shorts Studio
description: A focused workspace for original gameplay recordings.
colors:
  primary: '#d3ef7a'
  background: '#111315'
  surface: '#191c1f'
  muted-surface: '#202428'
  border: '#2b3035'
  foreground: '#f1f3ec'
  muted-foreground: '#a7afb5'
  destructive: '#ffaaaa'
typography:
  heading:
    fontFamily: 'Manrope Variable, sans-serif'
    fontWeight: 650
    letterSpacing: '-0.03em'
  body:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: '14px'
    lineHeight: 1.65
rounded:
  control: '8px'
  panel: '12px'
  media: '16px'
spacing:
  small: '8px'
  medium: '16px'
  panel: '24px'
  section: '32px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.background}'
    rounded: '{rounded.control}'
    padding: '10px 16px'
---

# Design System: Shorts Studio

## Overview

The source-footage desk: graphite surfaces, readable type, and lime actions. This describes the implemented interface, rather than a separate user-approved brand identity. The supplied gaming video is the dashboard's single focal image; operational pages remain compact and task-focused.

## Colors

Lime identifies primary actions and selected navigation. Warm white carries primary content; ash carries supporting text. Status labels pair text with color, never color alone. Semantic CSS variables in `src/styles.css` are the implementation source of truth.

## Typography

Self-hosted Manrope headings contrast with Geist interface text. Page headings scale between 26 and 34px. Supporting labels use 11–13px; source names use 13px. Metric values use tabular numerals. Long filenames truncate in rows and wrap in detail headings.

## Layout

Desktop uses a 232px fixed sidebar and a content area capped at 1512px. At 1180px the sidebar narrows to 206px. At 760px navigation becomes a horizontal scrolling row and content stacks. Totals change from four to two columns. Upload help remains readable below the form on narrow screens.

## Elevation & Depth

Tonal separation and fine borders define panels. The media itself provides dimensional depth; surrounding UI does not imitate 3D objects. The hero scrim protects text contrast over the supplied footage.

## Shapes

Controls have compact rounded corners; panels and media use progressively larger radii. Circles are reserved for avatars, status dots, and workflow step markers.

## Components

Shadcn/Radix primitives provide buttons, fields, alerts, badges, empty states, skeletons, and accessible preview tabs. Primary buttons use dark text on lime. Controls have visible focus outlines; icon buttons have 44px targets.

Motion uses shared CSS tokens: 150ms press feedback, 250ms state feedback and expanding disclosures. Publication polling stays still; only deliberate action confirmation enters. Reduced-motion preferences and keyboard interaction suppress positional motion. The video is muted and pausable; reduced motion and data saving prevent automatic source assignment. Off-screen and background playback pauses.

Preview tabs are clearly labeled unavailable and never trigger analytics or learning. Live publication and recording states originate from the API.

## Do's and Don'ts

- Do preserve semantic tokens, visible focus, readable labels, and responsive source rows.
- Do keep the supplied video separate from uploaded source media and preserve its provenance.
- Don't render the retained Efferd demos as additional dashboards or heroes.
- Don't introduce fabricated metrics or enable future processing through preview controls.
- Don't animate routine polling updates or make animation a prerequisite for an action.
