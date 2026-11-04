---
version: alpha
name: Mission decision and execution board
description: Gemini 4 HUD redesign with progressive disclosure and recorded execution activity.
colors:
  primary: "#1d4ed8"
  surface: "#ffffff"
  neutral: "#f8fafc"
  on-surface: "#0f172a"
  error: "#b91c1c"
rounded:
  sm: 6px
  md: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
---

# Mission HUD design contract

## Overview

The mission owner reviews a plan, approves execution, and inspects workers and validators in T3's companion pane. The plan decision and active milestone lead. Full contracts and transcripts remain available through focused views.

## Colors

Existing semantic tokens remain authoritative. Blue means active execution or primary action, amber means a decision or recommendation, emerald means success, and rose means failure. Readiness uses emerald at 80%, amber at 40–79%, and rose below 40%. Its callout appears below 60% or without an evaluation.

## Typography

Use the existing system sans stack for controls and content, and the mono stack for identifiers, commands, and time. Plan titles use 15px and feedback uses 13px. Time has tabular numerals. No font download is required.

## Layout

Keep the three-column desktop workspace. In narrow panes, stack the inspector and preserve access to sessions and model controls. Four segmented views share the same complete feature and assertion DOM. Completed, validated milestones collapse automatically unless active or explicitly expanded. The overview contract drawer is bounded at 220px above six assertions.

## Elevation & Depth

Use quiet borders and inset feedback surfaces. Reserve tight shadows for the primary decision and selected tab. Execution shimmer describes activity and never invents completion percentages.

## Shapes

Controls use 6px corners and cards use 8px corners. Status pills retain their existing rounded shape.

Desktop controls keep the existing compact 24–38px heights. At widths up to 600px, touch controls are at least 44px high. Identifier and status pills remain because they encode separate assertion, role, and lifecycle facts. The nested feedback surface is intentional: it groups revision text with the two plan decisions required by the supplied design.

## Components

- The approval card groups scope counters, title, hint, optional feedback, and adjacent revision and approval actions. Feedback is at least 38px high with 8px 12px padding and a visible focus ring.
- The board provides Overview & Milestones, Milestones & Features, Validation Contract, and Live Agent Stream. Tabs support arrow keys, Home, and End. Contract filters and collapse state affect CSS visibility only.
- The activity feed defaults to three recent events and expands to fifty. The session inspector shows the selected run's activity, task brief, and existing structured handoff. Long command and output sections scroll independently.
- Readiness reports are local, repository matched, and read only. A missing or low score never blocks approval. The badge describes a stored assessment, not the current revision's certification.

## Do's and Don'ts

- Preserve all selector IDs, the reject button attribute order, native effort selects, hidden legacy effort buttons, and V12–V14 feedback drafts.
- Render every feature and assertion regardless of the selected view. Escape all activity and task text.
- Keep retry runs separate. An event carrying a different run identity cannot match through its feature id.
- Keep model-setting events out of the center feed and coalesce them in the timeline.

## Design Maturity

- Status: Candidate
- Lock authority: The user's supplied Gemini 4 specification governs the requested layout and motion.
- Locked axes: Existing semantic colors, approval gate behavior, selector contracts, full DOM rendering, native effort dropdowns.
- Allowed variation: Responsive stacking, bounded transcript density, and defensive handling of absent optional DOM elements.

## Request Anchor

Implement the supplied Gemini 4 redesign, repair active elapsed time, expose recorded and available thread activity, show stored Agent Readiness, and keep both installed skill documents identical. Acceptance includes existing regressions, new behavior tests, full repository checks, coverage, HTTP security, and isolated browser interaction checks.

## Visual Fingerprint

The milestone stepper, unified amber decision card, segmented board, and compact blue activity rows identify the HUD. Dense metadata stays secondary. System type preserves the existing operations-console character. No new illustrative assets or layout alternatives are needed because the supplied design fixes the direction.

## OKF Preflight and decision bindings

Execution is single-agent. The supplied specification determines the layout. Craft Core and the web product branch guide spacing and interaction verification. The following motion concepts add separate verification obligations.

| Reference            | Decision                                                                                                              | Artifact target                                                                    | Verification                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `motion-language.md` | Restrict motion to execution liveness, progress continuity, and short view entry. Keep feedback editable immediately. | Status dots, progress bars, approval card, activity cards.                         | Browser interaction and computed animation checks.      |
| `motion-contract.md` | Keep active indicators static under reduced motion and preserve final readable content.                               | `prefers-reduced-motion`, `pulseDot`, `pulseRing`, `activityShimmer`, `cardEnter`. | Pinned Chromium checks under normal and reduced motion. |

## Motion contract

Status dots breathe in 1.6 seconds with a 2-second ring. Active cards shimmer in 2.2 seconds. Cards enter by 4px over 240ms. Progress width retargets over 450ms. These are CSS animations triggered by committed active state and view entry, with no scrolling timeline or delayed input. Dense text, forms, and commands stay stable. Reduced motion resolves each animation in 0.01ms and each transition in 0.01ms. No animation hides content after it settles. Verification samples computed animations and interactive views using `scripts/verify-hud-redesign.mjs`.

## Evidence and assumptions

The browser verifier uses an isolated local Mission and mock thread reader. It exercises actual HTTP, SSE, rendering, controls, and timers. Its success does not prove real provider dispatch or a live T3 thread transport. Report discovery supports the official `summary.achievedLevel` and `summary.overallProgress.percentComplete` format, with local and embedded normalized metadata as fallbacks.
