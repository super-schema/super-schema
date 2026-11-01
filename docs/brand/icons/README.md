# Super Schema icon concepts

Three product/app-icon directions generated with the built-in image generation tool.
Eight matching SVG feature icons are included in [features](features/README.md).
Schema Fold is the selected product mark. Its production vector is
[`src/app/icon.svg`](../../../src/app/icon.svg), shared by the header, auth
screens, and Next.js browser-icon metadata. The PNGs remain the original concepts.
GET and HEAD for this exact asset are public via
[`public-assets.ts`](../../../src/lib/public-assets.ts); image-like page URLs
and writes still pass through the session checks.

## Product brief

Super Schema gives technical users a workspace for defining logical data models
and producing technology-specific schema representations. The design direction
is **one model, connected representations**.

The original strategy describes a canonical logical schema separated from its
implementation formats. The current workbench and event documents describe
visual authoring, schema import/editing, reusable payload entities, and published
versions. The compiler source assembles fields, entity metadata, and relationships
into a model. These concepts informed the artwork; the proposal's projected
business outcomes and future capabilities are not treated as verified behavior.

## Visual fit

The existing application uses muted violet and blush against a charcoal dark
theme, with Inter typography, rounded surfaces, and Lucide interface icons.
The concepts reuse these colors from `src/app/globals.css`:

| Role | Color |
| --- | --- |
| Dark background | `#14141C` |
| Dark-theme primary | `#A97FB7` |
| Dark-theme secondary | `#F5C0C0` |
| Light-theme primary, reference only | `#8B5CA0` |

Each concept is a flat geometric symbol on a dark rounded-square tile.
The generated PNG is the original raster output, not a production SVG.
Generated raster colors can vary; use the exact theme tokens for final vectors.

## Concepts

| Concept | Meaning | File |
| --- | --- | --- |
| Canonical Hub | One logical model branching into several implementation schemas. | [PNG](01-canonical-hub.png) |
| Schema Fold | A distinctive S built from structured, connected planes. | [PNG](02-schema-fold.png) |
| Linked Layers | Reusable schema definitions remain connected across representations. | [PNG](03-linked-layers.png) |

**Starting recommendation: Schema Fold.** Its compact S silhouette offers a
more distinctive product identity. Canonical Hub communicates the one-to-many
workflow most directly; Linked Layers emphasizes reuse and consistency.

## Feature icons

The [feature set](features/README.md) covers Entities, Data Types, API Contracts,
Events, Governance, Versioning, Relationships, and Schema Generation. These are
native SVGs with a shared 24 px grid, 1.75 px strokes, themeable color, and an
optional accent. See the [preview sheet](features/preview.png) for dark/light
treatments and 16, 24, and 32 px samples. They were authored directly to stay
sharp at interface sizes and follow the application's existing line-icon style.

## Sources reviewed

- [Universal Schema strategy](../../../ref/Universal%20Schema.md), executive summary and logical/implementation separation.
- [Unified Schema Workbench](../../superpowers/specs/2026-10-14-unified-schema-workbench-design.md), authoring and import workflow.
- [Events design](../../superpowers/specs/2026-10-15-events-self-contained-design.md), implementation-status note and event/payload model.
- [Multi-entity emission design](../../superpowers/specs/2026-10-23-multi-entity-emission-design.md), reference and output-set intent; the document labels itself a draft.
- [Compiler](../../../src/lib/compiler/compiler.service.ts), `compileEntity`.
- [Theme tokens](../../../src/app/globals.css), light and dark palettes.
- [Top bar](../../../src/components/layout/TopBar.tsx), current text branding and interface icon usage.
- Existing empty-product visual-test snapshot, for the application's visual context.

## Generation and review

The built-in image generation tool was used for one independent PNG per concept.
Exact prompts are preserved in [PROMPTS.md](PROMPTS.md).

All three outputs are 1254 × 1254 RGBA PNGs. PNG chunk checksums, decompression,
square dimensions, a transparent corner, and local documentation links were
checked. The rendered outputs were visually reviewed. The concept-generation
round contained only artwork and documentation. The later application integration
uses SVG components and adds browser coverage for branding and navigation labels.

The three product PNGs are alternatives, not a combined icon family. Schema Fold
has been adapted to vector geometry and exact palette values for application use.
Trademark clearance has not been performed.
