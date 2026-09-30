# shadcn/ui components

These components were added from the official https://ui.shadcn.com registry using `npx shadcn@latest add` on 2026-09-30, with the `new-york` style and Radix UI primitives. They are actual registry source files, not lookalike replacements.

Components used by this application include Button, Card, Input, Textarea, Dialog, AlertDialog, Tabs, Badge, Label, Field and Table. Field uses Separator internally. The matching upstream MIT license is retained in `LICENSE.shadcn.md`.

Project aliases and future registry additions are configured in `/components.json`. Theme tokens live in `apps/web/src/shadcn-theme.css`; existing brand CSS adapts the primitives without replacing their accessible behavior. The current official registry uses the `cn` package from shadcn-ui for class merging.

The application wraps Dialog and AlertDialog in `src/ui.tsx` to keep Chinese labels, preserve focus return, and reuse the brand layout. Destructive actions explicitly wait for their asynchronous operation before closing the AlertDialog.
