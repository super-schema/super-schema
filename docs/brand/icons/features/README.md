# Feature icons

Eight SVG feature icons for Super Schema, alongside the three product-icon
concepts in the parent directory. These files are assets for review; existing
Lucide components in the application have not been replaced.

[Preview sheet](preview.svg) · [PNG preview](preview.png)

| File | Product meaning |
| --- | --- |
| [Entities](entities.svg) | Logical models and their fields |
| [Data types](data-types.svg) | Reusable typed definitions |
| [API contracts](api-contracts.svg) | Typed service interfaces |
| [Events](events.svg) | Messages and channel contracts |
| [Governance](governance.svg) | Classification and validation rules |
| [Versioning](versioning.svg) | Published schema history |
| [Relationships](relationships.svg) | Linked entities and lineage |
| [Schema generation](generation.svg) | One model, multiple formats |

## Construction

- 24 × 24 view box, 1.75 px strokes, round caps and joins.
- Transparent background; no fonts, scripts, embedded raster data, or external resources.
- Monochrome by default through `currentColor`.
- One optional accent through `--icon-accent`, falling back to `currentColor`.
- Native SVG geometry, following the application's existing line-icon conventions;
  these feature icons were authored directly rather than generated as raster images.

For inline SVG, set `color` on the SVG or its parent and optionally set
`--icon-accent`. The preview's dark palette uses primary `#A97FB7` and accent
`#F5C0C0`. Its light samples use `#8B5CA0` for both strokes so a pale pink
detail does not disappear against white.

An external `<img src="…svg" alt="Entities">` does **not** inherit the page's
`color` or CSS custom properties. Inline the SVG when theme coloring is needed.

Each standalone SVG has an accessible label. When placed beside equivalent
visible text, mark the inline SVG `aria-hidden="true"` and remove its `role`
and `aria-label`; put the accessible name on an icon-only button itself.

## Product fit

The first four symbols match the product workspace's Entities, Data Types,
APIs, and Events categories. Governance expresses classification and validation
rules; Versioning represents published history; Relationships represents entity
references and lineage; Schema Generation represents a shared model producing
multiple outputs. The [parent brief](../README.md) records the source documents.

The preview shows each symbol at 16, 24, 32, and 48 px and on dark/light surfaces.
SVG structure and links are checked, and the rendered sheet is reviewed. Actual
application placement, interaction, and accessibility still need validation when
these assets are integrated.
