---
name: figma-code-connect
description: Generate Figma Code Connect templates that bind published Figma components to the code components that implement them, so Figma Dev Mode shows real code and later design-to-code work reuses the right component.
whenToUse: The user asks to set up or extend Code Connect, map Figma components to code, or make Dev Mode show their components; or a design-to-code task keeps re-implementing components that already exist in the repo.
---

# Map Figma components to code with Code Connect

Code Connect is a checked-in mapping from a published Figma component to the
code that implements it. It is what turns "here is a design" into "use
`<Button variant="primary">`".

## 1. Inventory the Figma side

```
figma_get_components({ url, includeSets: true })
```

For each component you get its `key`, `name`, `nodeId`, and — for component
sets — the variant property definitions. You need:

- the component's **node URL**, which is what a Code Connect mapping targets
  (`https://www.figma.com/design/<fileKey>/<name>?node-id=<nodeId>`)
- its **variant properties**, because each becomes a mapped prop
- the **component name**, to find the code counterpart

If a component has no variant properties and no counterparts in the repo, skip
it — a mapping nobody can use is noise.

## 2. Inventory the code side

Find the actual component and its prop types. Read the source; do not guess
prop names from the Figma layer name. Record for each mapping:

- the import path and exported name
- the prop names and their allowed values
- which Figma properties correspond to which props
- any prop with no Figma counterpart (it becomes a fixed `example` value)

## 3. Check the project's Code Connect setup first

Look for an existing `figma.config.json` and any existing `*.figma.ts` files.
Match their conventions exactly — file naming, directory layout, import style,
and whether they use a shared `figma.connect` helper. If the project has none,
propose the layout before creating a dozen files.

A minimal config points Code Connect at the template files:

```json
{
  "codeConnect": {
    "include": ["src/**/*.figma.ts"],
    "parser": "react"
  }
}
```

## 4. Write one template per component

A template is a `figma.connect(...)` call: the code component, the Figma node
URL, the property mapping, and a runnable example.

```ts
import figma from '@figma/code-connect';
import { Button } from './Button';

figma.connect(Button, 'https://www.figma.com/design/<fileKey>/DS?node-id=12-345', {
  props: {
    variant: figma.enum('Variant', {
      Primary: 'primary',
      Secondary: 'secondary',
    }),
    disabled: figma.boolean('Disabled'),
    label: figma.string('Label'),
  },
  example: ({ variant, disabled, label }) => (
    <Button variant={variant} disabled={disabled}>{label}</Button>
  ),
});
```

Rules that keep templates working:

- **One mapping per component.** Use `figma.enum` over a variant property
  rather than one mapping per variant.
- **Property names must match Figma exactly** — they are the layer's property
  names, case included. A typo silently yields `undefined` in Dev Mode.
- **The example must compile.** It is real code shown to designers and copied
  by developers; a broken example is worse than no mapping.
- **Map only what differs.** Props with a single value in the design can be a
  literal in the example rather than a mapping.

## 5. Verify and publish

Templates are only useful once published:

1. Type-check the templates with the project's own toolchain.
2. Publish with the Figma CLI (`npx figma connect publish`), which needs a
   Figma access token with Code Connect scope and write access to the library
   file.
3. Confirm in Dev Mode that the component now shows the mapped code.

Publishing is a write to Figma and needs the user's explicit go-ahead — do not
run it as a side effect of generating files.

## Failure modes to avoid

- Guessing prop names instead of reading the component's source.
- Mapping a component set to several code components when one component with a
  prop is the real counterpart.
- Generating templates for components that were never published, which cannot
  be targeted.
- Committing a config that includes a glob matching no files.
