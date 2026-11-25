# 0007 — Nuxt UI in the existing desktop renderer

Status: accepted

## Context

The factory needs a coherent daily-use interface with the compact navigation and smooth request/detail flow of Linear. The renderer is Vue/Vite inside Tauri, and its human approval boundaries must remain authoritative in the service.

## Decision

Use Nuxt UI 4’s Vue/Vite integration rather than migrating the application to Nuxt. A root UApp supplies overlays/toasts. Use shared Nuxt UI primitives for forms, dialogs, menus, tabs, badges, disclosures, and command search. Keep layout and typography in one tokenized stylesheet, with a graphite default and a locally persisted light appearance.

Bundle Lucide icons at build time, scanning both Vue and TypeScript icon declarations. Use system font fallbacks without external requests. Leave native CSP and interpreter-based frontend schema validation intact.

Requests and repository registration use focused dialogs. Task details use tabs and a persistent properties/checkpoint rail. Diff/log disclosure is lazy; raw evidence and full digests remain inspectable. All mutation handlers still send the existing version/digest/HEAD-bound commands. Simulation stays explicitly identified.

## Consequences

The UI receives accessible focus/overlay/keyboard primitives and consistent controls, with a larger bundled renderer. Vite generates component/theme declarations before Vue typechecking during production builds. No database migration, backend API change, network font/icon dependency, or approval bypass is introduced.
