---
name: figma-design-to-code
description: Implement a Figma frame or component as production UI code with high visual fidelity — read the design context, map it onto the project's existing components and tokens, then verify the result against a rendered screenshot.
whenToUse: The user shares a Figma link (or a file key plus node id) and asks to build, implement, port, or "match" a design in code; or asks why an implemented screen does not look like the design.
---

# Implement a Figma design in code

Turn one Figma node into working UI that matches the design and fits the
repository it lands in. Fidelity is the goal; guessing is the failure mode.

## 1. Pin the target node

A Figma URL carries the file key and, after `?node-id=`, the node. Pass the
whole URL to the tools — `figma_get_design_context` parses it. If the user
gave only a file link with no node, call `figma_get_file` first and pick the
frame from the outline; never implement a whole page when one frame was meant.

If the link points at a page, section, or component set rather than a single
frame, say so and ask which child to implement.

## 2. Read the design before writing code

```
figma_get_design_context({ url, includeScreenshot: true })
```

This returns an indented outline of the node tree (geometry, auto-layout,
fills, typography, component identity, bound variables) plus a rendered
screenshot you can look at. Read both:

- The **outline** is the authority on structure, spacing, and type.
- The **screenshot** is the authority on visual intent — overlaps, layering,
  and things the API reports oddly.

For a large frame the outline may be truncated (`truncated: true`). Re-request
the specific subtree by its node id rather than raising the limits blindly; a
400-node dump is worse than two focused reads.

## 3. Map onto the repository before inventing anything

This is the step that separates a good implementation from a plausible one.

1. Find the project's existing primitives: search for its button, input,
   card, and layout components, and its design-token or theme file.
2. Find its styling idiom — CSS modules, Tailwind, styled-components, plain
   CSS, a component library. Match it. Do not introduce a second styling
   system for one screen.
3. Call `figma_get_variables` when the outline shows `boundVariables`, and
   `figma_get_styles` for published text and effect styles. Prefer a token the
   project already has over a hard-coded hex or pixel value; if the design uses
   a token the codebase lacks, add it to the token file rather than inlining it.
4. Map Figma components to code components. When an instance's
   `component.componentName` matches an existing component, use that component
   with equivalent props instead of re-implementing its markup.

Report any mapping you could not make (a component with no counterpart, a
token with no equivalent) instead of silently inventing one.

## 4. Translate layout faithfully

- **Auto-layout → flex/grid.** `layout.mode: HORIZONTAL` is a row,
  `VERTICAL` a column. `itemSpacing` is `gap`; `padding` maps directly.
  `primaryAxisAlignItems` / `counterAxisAlignItems` are `justify-content` /
  `align-items`.
- **Fixed sizing is real.** A node with `counterAxisSizingMode: FIXED` and a
  `box.width` is not a flexible element. Do not replace deliberate fixed
  dimensions with `flex: 1` or `w-full`.
- **`layoutGrow: 1`** means the child absorbs free space (`flex-grow: 1`).
- **`layoutPositioning: ABSOLUTE`** means the child is taken out of flow —
  use absolute positioning, not a flex child.
- **Nested frames are layout, not decoration.** Reproduce the nesting; do not
  flatten a wrapper frame into margins on its children.

## 5. Typography and color

Use the reported values, not your eye:

- `text.fontFamily`, `fontWeight`, `fontSize`, `lineHeight` (px),
  `letterSpacing` (px), `textAlignHorizontal`, `textCase`.
- `lineHeightUnit` is the line height as a multiple of font size — use it for
  `line-height: 1.5` style values when that matches the codebase.
- Colors are hex with an alpha suffix when not opaque (for example `#0B0B0F80`
  is 50% alpha). `fill` on the outline is the topmost paint only; check the
  full `fills` array in the structured tree for gradients and images.
- Effects (`effects`) are shadows and blurs — reproduce them, including the
  `spread` value that CSS `box-shadow` takes as its fourth length.

## 6. Verify, do not assume

Render the implementation and compare against the design screenshot. If the
project has a dev server, a component test, or a screenshot tool, use it.
Then compare at least:

- overall size and the position of the primary content block
- spacing between the major groups
- text size, weight, and line breaks
- corner radii, borders, and shadows
- state variants the design shows (hover, disabled, focus)

When something cannot match exactly — a font the project does not have, a
gradient the framework cannot express — say so explicitly and name the
substitute you chose.

## Failure modes to avoid

- Implementing the screenshot's pixels instead of the outline's structure.
- Hard-coding hex values that exist as project tokens.
- Inventing a component the design does not show, or dropping one it does.
- Ignoring `visible: false` nodes: the outline omits them, and so should the code.
- Treating a component set as a single frame — its variants are separate
  implementations behind one component API.
