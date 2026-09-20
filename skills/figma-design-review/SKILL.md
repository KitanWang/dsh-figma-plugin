---
name: figma-design-review
description: Review an implementation against its Figma design — compare rendered output with the design screenshot, report concrete deltas with measured values, and optionally file them as Figma comments on the exact nodes.
whenToUse: The user asks whether an implementation matches the design, wants a design QA or parity pass, or wants review feedback delivered back into Figma.
---

# Review an implementation against its design

A design review produces a list of concrete, checkable deltas — not
impressions. Every finding names a node, a property, and both values.

## 1. Get the design side, with a screenshot

```
figma_get_design_context({ url, includeScreenshot: true })
```

Keep the screenshot: you will compare against it directly. Note the frame's
own size — a review against the wrong breakpoint is worse than no review.

## 2. Get the implementation side

Run the app (or the component's story/test) and capture it at the **same
width** as the Figma frame. If the project has a screenshot or visual-test
setup, use it rather than improvising a browser launch.

If you cannot render the implementation, say so and review only what you can
read from source — then state clearly which findings are unverified.

## 3. Compare property by property

Work through this list in order. It is ordered by how often it is wrong and
how visible the error is:

1. **Overall frame size and primary block position.**
2. **Spacing** between major groups, then inside components. Compare against
   `itemSpacing` and `padding` from the outline, not against your impression.
3. **Typography** — family, weight, size, line height, letter spacing,
   alignment, and text case.
4. **Color** — fills, text colors, borders, and opacity.
5. **Shape** — corner radii, border widths and alignment, shadows (including
   spread).
6. **Icons and images** — the right asset, the right size, the right
   alignment.
7. **Content** — every string, in the right order, including empty and
   long-text cases the design does not show.
8. **States** — hover, focus, disabled, loading, error, as far as the design
   or the component defines them.

For each difference, record: node name and id, the design value, the
implementation value, and the file and line in the code responsible.

## 4. Classify before reporting

- **Bug** — the implementation is wrong against a clear design intent.
- **Design ambiguity** — the design does not say (missing state, undefined
  responsive behavior, a token used inconsistently). Report as a question, not
  a defect.
- **Intentional divergence** — the codebase deliberately differs (platform
  conventions, accessibility, a design that predates a system change). Call it
  out and do not "fix" it.
- **Missing implementation** — the design shows something the code has not
  built at all.

Separating these is the point of the review. A list that mixes them gets
ignored.

## 5. Optionally deliver the findings into Figma

When the user wants feedback on the canvas, post it on the exact node:

```
figma_post_comment({ url, nodeId: '<node id from the outline>', message: '…' })
```

Rules for comments you post:

- One node per comment. Do not attach a general remark to an arbitrary node.
- State the delta, both values, and the code location.
- Confirm before posting: a comment is visible to the whole team and notifies
  watchers. Posting is a write, and it is never the default.
- Use `figma_get_comments` first when reviewing an existing thread, so you
  reply in context rather than duplicating a point already made.

## Failure modes to avoid

- Reviewing at a different viewport width than the design frame.
- Reporting "spacing looks off" instead of the two measured values.
- Listing every 1px difference as a bug while missing a missing state.
- Posting comments to Figma without being asked to.
- Claiming visual verification when you never rendered the implementation.
