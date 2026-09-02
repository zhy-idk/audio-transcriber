---
inclusion: always
---

# Precision Core Design System

```yaml
name: Precision Core
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#45464d'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#76777d'
  outline-variant: '#c6c6cd'
  surface-tint: '#565e74'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#131b2e'
  on-primary-container: '#7c839b'
  inverse-primary: '#bec6e0'
  secondary: '#0058be'
  on-secondary: '#ffffff'
  secondary-container: '#2170e4'
  on-secondary-container: '#fefcff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#191c1e'
  on-tertiary-container: '#818486'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#adc6ff'
  on-secondary-fixed: '#001a42'
  on-secondary-fixed-variant: '#004395'
  tertiary-fixed: '#e0e3e5'
  tertiary-fixed-dim: '#c4c7c9'
  on-tertiary-fixed: '#191c1e'
  on-tertiary-fixed-variant: '#444749'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: '0'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-md:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
  mono-code:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1280px
  gutter: 24px
  margin-sm: 16px
  margin-md: 32px
  margin-lg: 64px
```

## Brand & Style

The design system is engineered for high-performance AI transcription, targeting developers, researchers, and enterprise professionals who require extreme clarity and speed. The brand personality is **Precise, Technical, and Reliable**.

The aesthetic follows a **Modern Corporate** style with a focus on **Systematic Minimalism**. It utilizes heavy whitespace to reduce cognitive load during complex data processing tasks. The UI leverages "Soniox-inspired" depth—using subtle tonal shifts rather than aggressive decoration—to guide the user through the transcription lifecycle: upload, processing, and editing.

Emotional Response:
- **Trust:** Through stable, grounded typography and a cooling color palette.
- **Efficiency:** Through a high-contrast action hierarchy that makes primary tasks unmistakable.
- **Clarity:** Through a rigorous grid and generous character spacing.

## Colors

The palette is anchored in professional deep blues and slate grays, ensuring a crisp, high-contrast reading environment.

- **Primary (#0F172A):** A deep "Midnight Slate" used for headlines, primary navigation, and high-impact UI boundaries. It provides the "weight" of the interface.
- **Secondary (#3B82F6):** A vibrant "Electric Blue" reserved exclusively for interactive actions (Upload, Export, Playback) and progress indicators.
- **Neutral/Surface:** A spectrum of slate grays (#64748B) for secondary text and #F8FAFC for background surfaces to maintain a clean, airy feel.
- **Success/Action:** High-contrast mint or emerald tints are used sparingly for "Transcription Complete" states, ensuring they pop against the blue-gray foundation.

## Typography

This design system utilizes a dual-font strategy to balance technical precision with readability.

- **Headlines & Labels:** **Geist** provides a geometric, technical feel. Its tight tracking and monolinear strokes suggest a developer-centric, "engineered" quality. Use for all structural headings and metadata labels.
- **Body & Transcription Text:** **Inter** is used for all long-form reading. It is optimized for screen legibility, particularly for the variable density of AI-generated transcripts.
- **Scale:** Large display sizes use negative letter spacing to feel "tighter" and more modern. Small labels use increased tracking and uppercase styling to ensure visibility in dense data tables.

## Layout & Spacing

The layout utilizes a **12-column fluid grid** for the main dashboard and a **fixed-width central column** (768px) for the "Transcription Editor" view to maximize focus.

- **Rhythm:** All spacing is derived from an 8px base unit.
- **Desktop:** 24px gutters with 64px outer margins. The sidebar is fixed at 280px.
- **Tablet:** 16px gutters with 32px margins. Sidebars collapse into a drawer.
- **Mobile:** 16px gutters and margins. All multi-column cards stack vertically.
- **Component Padding:** Buttons and inputs use a strict 12px vertical / 20px horizontal padding ratio to maintain a professional, "un-cramped" appearance.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and **Ambient Shadows**.

1. **Level 0 (Background):** Pure white (#FFFFFF) or very light slate (#F8FAFC).
2. **Level 1 (Cards/Sidebar):** A subtle 1px border (#E2E8F0) with no shadow, creating a "flat but separated" look.
3. **Level 2 (Modals/Active Menus):** A highly diffused, low-opacity shadow (Color: #0F172A at 8% opacity, Blur: 20px, Y-Offset: 10px). This provides "air" without looking heavy.
4. **Tonal Depth:** For AI-processing states, use a light blue background tint (#EFF6FF) to distinguish "Active/Processing" areas from "Static/Historical" ones.

## Shapes

The shape language is **"Precision Softness."** Elements are not sharp (which feels aggressive) nor fully rounded (which feels casual).

- **Base Radius (Soft):** 0.25rem (4px) for small interactive elements like checkboxes, tags, and radio buttons.
- **Standard Radius:** 0.5rem (8px) for primary buttons, input fields, and standard cards.
- **Large Radius:** 0.75rem (12px) for main dashboard containers and modal windows.
- **Focus States:** 2px solid blue offset by 2px to ensure accessibility without breaking the component's silhouette.

## Components

- **Primary Buttons:** Solid #0F172A for "Final" actions (Export/Save). Solid #3B82F6 for "Trigger" actions (Upload/Start). Both feature 0.5rem corners and Geist Semibold typography.
- **Upload Zone:** A dashed 2px border in Slate-300 with a #F8FAFC background. On drag-over, the border transitions to Primary Blue with a 10% blue wash.
- **Transcription Cards:** Use a Level 1 elevation (1px border). The "Time-stamp" should be Geist Mono in a muted gray to separate it from the editable Inter text.
- **Input Fields:** 1px border (#CBD5E1) that transitions to a 2px Blue (#3B82F6) border on focus. Labels sit strictly above the input in Geist Label-md style.
- **Audio Scrubber:** A thin Slate-200 track with a Secondary Blue progress bar. The handle is a clean white circle with a Level 2 shadow.
- **Chips/Status:** For "Processing," use a subtle pulse animation on a Slate chip. For "Success," use a Mint Green chip with dark green text.
