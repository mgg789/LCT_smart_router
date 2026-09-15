# Beeline visual reference for LCT Smart Router

Checked: **2026-09-15**. Scope: dispatcher, engineer and client interfaces.

## Status and authority

The project owner requested Beeline colours and symbols on 2026-09-15. This
document applies that direction to the existing light, restrained UI in
[context/10](../../../context/10-ux-ui-design.md). It does not change product scope.

**This is a project design guide, not an official Beeline brandbook.** A complete,
current public Russian Beeline brandbook was not located in this search. The
official public Yellowbe documents below describe a design platform; they do not
publish a complete brand palette, logo clear-space rules or a redistribution licence.
Website observations and our own UI decisions are explicitly separated below.

## Official sources stored locally

| File | Source and purpose |
|---|---|
| [Yellowbe user guide](sources/yellowbe-user-guide.pdf) | [Official PDF](https://static.beeline.ru/upload/images/business/beeline-prodvizhenie/Rukovodstvo_polzovatelya_Yellowbe.pdf), 13 pages. Pages 3–4 describe the platform and tokens; pages 7–8 describe logo, font and favicon assets; pages 12–13 describe design-library usage. |
| [Yellowbe functional description](sources/yellowbe-functional-description.pdf) | [Official PDF](https://static.beeline.ru/upload/images/business/beeline-prodvizhenie/Opisanie_funkcionalnyh_harakteristik_Yellowbe.pdf), 6 pages. Platform scope and intended use. |
| [Beeline symbol](assets/beeline-symbol-official-site.png) | [Official PNG](https://static.beeline.ru/upload/images/business/main/v3/Beeblik_2025.png), unchanged 120 × 120 RGBA asset referenced by the business website header. A symbol, not a full wordmark or vector master. |
| [Website colour excerpt](sources/official-site-colors.css) | Selected declarations from the official site's stylesheet, with source URL. Evidence, not a library to import. |
| [Source manifest](sources/manifest.json) | Retrieval date, URLs, sizes and SHA-256 hashes of the local copies. |

The [official Yellowbe product page](https://moskva.beeline.ru/business/beeline-prodvizhenie/yellowbe/)
links both PDFs. Its FAQ describes library and Handbook access after a contract
and payment. The public PDFs alone do not provide those packages or access.
Do not introduce a Yellowbe dependency just because its package names appear in
the guide; this repository retains its existing stack.

## Colour evidence and project mapping

The following values were observed in
[the official business website CSS](https://moskva.beeline.ru/business/v3_commonStyles.29b04f11.css)
on the date above. They are website implementation values, **not a claim about
the complete corporate palette or the private Yellowbe theme**.

| Observed declaration | Value | Smart Router usage (project decision) |
|---|---|---|
| `--yellowPrime` | `#FED305` | Primary action background, active-navigation accent, selected-item accent |
| `--black` | `#000000` | Text on the primary yellow action; brand contrast |
| `--white` | `#FFFFFF` | Main light surface |
| `--yellow4` | `#FFE161` | Optional secondary decorative yellow; not warning text |
| `--green` | `#22B26D` | Reference only; do not assume sufficient contrast for small status text |
| `--red` | `#EF2525` | Reference only; semantic errors need independent contrast checks |
| `--blue` | `#3F9FE4` | Reference only; not the primary brand accent |

Project-only supporting colours: `#FAFAF8` canvas, `#202124` primary text,
`#5F6368` secondary text and `#E4E5E7` decorative separators. These are our UI
choices, not official Beeline tokens. Separators alone must not define required
input boundaries or focus states.

Use semantic tokens in future frontend implementation. The earlier generated
mockups used approximate `#FFD54A`; use `#FED305` for subsequent work. The phrase
“Beeline blue” in context/10 has been superseded for the primary accent.

## Interface rules — project decisions

- Keep the map, schedules and explanations prominent. Yellow identifies a small
  number of actions or selections; it is not a background for the entire workspace.
- Use dark text on yellow buttons. Do not use yellow text on white or white text
  on yellow for ordinary labels. Check text and control contrast in the final UI.
- Preserve separate error, warning and success semantics. A warning needs an icon
  and explicit wording so it cannot be mistaken for a yellow primary action.
- Routes need distinct colours plus numbers/names. Do not make every engineer's
  route yellow or use the brand symbol as a location/status marker.
- Use the same foundations across all three roles. Layout and information density
  follow each role's tasks; branding does not add new product features.
- Preserve the existing 4-point grid, 8–12 px radii and restrained motion rules.
  Use Inter or Golos Text as the existing project typography. Beeline Sans is
  mentioned in the official guide, but its font files and use terms are not supplied
  here; it has not been downloaded, installed or relabelled as a free font.

## Symbol and naming — project decisions

Use the supplied official symbol without redrawing it, replacing its stripe
geometry, recolouring it, cropping it or stretching its aspect ratio. Generated
logos in earlier concepts are not approved source assets.

For a header, a 32–40 CSS px symbol with at least 8 px free space is a practical
project default, **not an official minimum-size or clear-space rule**. The 120 px
PNG is suitable for small UI uses; obtain the official vector master for large
presentation graphics instead of enlarging or automatically tracing this file.

Keep the product name **LCT Smart Router**. Present `билайн бизнес` as the case
context, for example `Кейс «билайн бизнес» · ЛЦТ 2026`. Do not invent a merged
official Beeline/Smart Router logo or describe the hackathon prototype as an
officially released Beeline product. Ordinary text is not a substitute for an
official wordmark asset.

Third-party documents and the symbol retain their respective owners' rights.
Public availability and local storage do not establish an open-source licence.
Official co-branding rules, vector wordmarks, font rights and the current full
brandbook remain items to obtain from the case organiser if needed.

## Sources not treated as current design authority

- The widely mirrored 2005 brandbook is historical and was not added as today's
  standard.
- [Art. Lebedev's Beeline Business design-system case](https://www.artlebedev.ru/beeline/design-system/)
  is an original designer's reference, not a current downloadable brandbook.
- `beeline.com/design-system` belongs to a different Beeline business with green
  branding. It is not a source for the Russian telecom case.

## Verification and maintenance

The downloaded PDFs have 13 and 6 readable pages respectively. Representative
pages and the transparent symbol were rendered and visually inspected. Copies
are stored unchanged; hashes are recorded in the manifest. The selected CSS
declarations were checked against the live stylesheet.

This update contains documentation and reference assets only. No frontend,
library integration or rendered product behaviour has been implemented or tested.
Recheck source availability and branding before adopting a new official pack;
update this guide, the manifest and context/10 together.
