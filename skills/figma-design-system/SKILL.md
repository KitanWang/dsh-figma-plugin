---
name: figma-design-system
description: Inventory a Figma design system — variables, published styles, components and variants — and turn it into project design tokens plus durable rules that keep later design-to-code work consistent.
whenToUse: The user wants design tokens synced from Figma, a design-system inventory or audit, or a rules document that tells the agent how to use this project's design system.
---

# Extract and maintain a Figma design system

Produce two things: a machine-readable token set the codebase can consume, and
a short rules document that makes every later implementation consistent with it.

## 1. Inventory the design system

Run these against the library file (the file that publishes the components and
variables, not a screen file that merely consumes them):

```
figma_get_variables({ url, format: 'both' })
figma_get_styles({ url, resolve: true })
figma_get_components({ url, includeSets: true })
```

- `figma_get_variables` returns one entry per variable with a value per mode.
  Aliases are resolved to their target name and value; a `circular` marker
  means the alias chain loops and must be fixed in Figma, not in code.
- `figma_get_styles` returns published paint, text, effect, and grid styles
  **with their values** (it resolves each style's node). Names alone are not an
  inventory.
- `figma_get_components` returns components and component sets, so you can see
  which variants exist rather than assuming a single shape.

Variables require a Figma **Enterprise** plan and a token with
`file_variables:read`. If the call fails with a 403, say so plainly and fall
back to `figma_get_styles` — do not fabricate token values.

## 2. Decide the mapping, then write it down

Match Figma's naming to the project's conventions. The token names Figma
reports are hierarchical (`color/background/default`, `space/200`). The code
target may want CSS custom properties, a JS/TS theme object, a Tailwind
config, or a platform resource file.

Write the output where the project already keeps its tokens — never create a
second source of truth. Use `writeTo` on the tool when a CSS or JSON file is
the right artifact, then integrate it into the project's own token file.

Rules for the mapping:

- **Modes are themes.** Figma modes (Light/Dark, Compact/Comfortable) become
  the code's theme mechanism. `tokensToCss` emits the default mode into
  `:root` and each additional mode into a `[data-figma-mode="…"]` block; adapt
  that selector to the project's actual theme switcher.
- **Preserve names.** A token called `color/text/muted` should stay
  recognizably that. Renaming on import makes the next sync a merge conflict.
- **Aliases stay aliases.** If a Figma variable aliases another, point the
  code token at the target token rather than copying the resolved value.
- **Do not invent tokens.** Only tokens Figma actually defines belong in the
  file.

## 3. Emit design-system rules for the project

Write a short rules document into the repository (for example
`docs/design-system-rules.md`, or append to the project's existing agent
instructions). It should state, concretely and in the project's own terms:

- which token file is the source of truth, and how tokens are named
- which component library is canonical for each primitive (button, input,
  select, card, modal, icon)
- the styling idiom in use, and what is forbidden (for example "no inline
  hex colors", "no new CSS files for one screen")
- how Figma components map to code components, including variant → prop
- the theme mechanism and how modes are selected at runtime
- what to do when the design uses something the system lacks: extend the token
  file, never inline the value

Keep it short enough to be read every time. A rules document nobody reads is
worse than none.

## 4. Re-sync without churn

When re-running the inventory against a changed library:

- Diff before writing. Report added, removed, and renamed tokens and
  components; a rename is a breaking change, not an addition.
- Never delete a token the codebase still references — report it as unused and
  let the user decide.
- Preserve manual additions in the token file: merge, do not overwrite.

## Failure modes to avoid

- Copying resolved alias values instead of preserving the alias.
- Emitting every mode into one flat token set, losing the theme distinction.
- Treating a screen file's local variables as the library's design system.
- Generating hundreds of tokens nobody asked for instead of the set the
  project will actually consume.
