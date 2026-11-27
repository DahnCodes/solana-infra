# Breakglass design direction

Approved in step 1.1 (Nov 27 2026). Step 1.2 turns this into the tokens file; after that, every screen uses tokens, never raw values.

## Direction

A calm, monochrome console, modelled on the Parallel dashboard (seen on Refero): a light grey canvas, white cards with large corners and no shadow, hairline-bordered panels inside them, and quiet data tables. Breakglass is a black-and-white product. **Charcoal is the primary colour**: it marks emphasis, the main action, selection and focus. Everything else is greyscale.

Colour is never decoration. The only hues are three status colours, and they appear in small doses (a dot, an icon, a meter mark), never as fills for buttons, cards or large areas.

## Colour

### Light (default)

| Token            | Value     | Role                                                        |
| ---------------- | --------- | ----------------------------------------------------------- |
| `canvas`         | `#F2F2F2` | Page background, sidebar                                    |
| `surface`        | `#FFFFFF` | Cards, active nav item, inputs, secondary buttons           |
| `surface-inset`  | `#F7F7F7` | Panels and table headers inside cards, skeleton bars        |
| `border`         | `#E4E4E4` | Hairlines: panel outlines, table rows, dividers             |
| `border-strong`  | `#CFCFCF` | Secondary button outline, input outline, hover              |
| `text`           | `#232323` | Body text and headings (charcoal)                           |
| `text-secondary` | `#5C5C5C` | Descriptions, supporting copy                               |
| `text-muted`     | `#6B6B6B` | Labels, captions, placeholders (4.8:1 on canvas)            |
| `primary`        | `#232323` | Primary button, emphasis, selection, focus ring, meter fill |
| `primary-hover`  | `#3A3A3A` | Primary button hover                                        |
| `on-primary`     | `#FFFFFF` | Text and icons on `primary`                                 |

### Dark

| Token            | Value     |
| ---------------- | --------- |
| `canvas`         | `#161616` |
| `surface`        | `#1F1F1F` |
| `surface-inset`  | `#1A1A1A` |
| `border`         | `#2E2E2E` |
| `border-strong`  | `#404040` |
| `text`           | `#F2F2F2` |
| `text-secondary` | `#B0B0B0` |
| `text-muted`     | `#949494` |
| `primary`        | `#F2F2F2` |
| `primary-hover`  | `#D9D9D9` |
| `on-primary`     | `#232323` |

In dark mode the primary flips to white, so the product stays black and white in both themes.

### Status (small doses only)

| Token     | Light     | Dark      | Means                                          |
| --------- | --------- | --------- | ---------------------------------------------- |
| `open`    | `#1E8E5A` | `#3DBF83` | Allow, scope open, check passed                |
| `held`    | `#B26B00` | `#E0A33A` | Hold, queued, timelock waiting                 |
| `tripped` | `#C5221F` | `#F0625D` | Deny, scope paused, auto-trip, rejected, error |

Status is always carried by a word or an icon too, never by colour alone.

### Selection and focus

- Text selection: `primary` background, `on-primary` text.
- Focus: a 2px `primary` ring with a 2px offset, on every interactive element.

## Typography

| Family                  | Weights       | Role                                                                                  |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------- |
| **Schibsted Grotesk**   | 400, 500, 600 | Main face: body, headings, nav, tables, amounts                                       |
| **Montserrat SemiBold** | 600           | Small labels: nav group names, table headers, button labels, status chips, step names |
| **Montserrat Light**    | 300           | Large figures: window usage, countdowns, key amounts on the dashboard                 |

All three are open-licence Google Fonts, loaded through `next/font/google`. (Artific was considered; its trial licence is personal use only and its character set is incomplete.)

### Scale

The sizes come from the text styles of the human's Figma file "ENLGA Data and Payment Project" (Style guide page, frame `173:208`). That file sets them in Urbanist; Breakglass keeps the sizes and the 1.4 line height and applies them to the faces above, with one change the human asked for: `body` is 16px, not the file's 13px. Letter spacing is 0 except on labels.

| Step      | Size / line (px) | Face and use                                                                    |
| --------- | ---------------- | ------------------------------------------------------------------------------- |
| `h1`      | 48 / 67          | Montserrat Light: hero figures (a hold's countdown, window usage on its page)   |
| `h2`      | 40 / 56          | Schibsted 500: landing page headline                                            |
| `h3`      | 33 / 46          | Schibsted 400: page title                                                       |
| `h4`      | 28 / 39          | Montserrat Light: figures on dashboard cards; Schibsted 500: section titles     |
| `h5`      | 23 / 32          | Schibsted 500: card title, dialog title                                         |
| `title1`  | 19 / 27          | Schibsted 400: card description, lead text                                      |
| `title2`  | 16 / 22          | Schibsted 500: nav items, form field labels, emphasised rows                    |
| `body`    | 16 / 22          | Schibsted 400: default text, table cells, form fields, helper text              |
| `caption` | 11 / 15          | Montserrat SemiBold, +0.04em: table headers, nav group names, chips, timestamps |

`body` and `title2` share a size; `title2` is the medium-weight version for labels and emphasis. Nothing a person reads in sentences goes below 16px. `caption` is only ever Montserrat SemiBold; Montserrat Light is never used below `h4`, where thin strokes stop being legible.

Amounts and countdowns use tabular figures so digits don't jump as they change. Addresses are shortened (`7xKp…3fQ`) and set in Schibsted, with a copy button; no monospace face.

## Spacing and layout

- 4px base. Scale: 4, 8, 12, 16, 24, 32, 48, 64.
- Sidebar 264px on the canvas, no border. Active item is a `surface` pill.
- Content up to 1200px, left-aligned, 48px from the sidebar.
- Cards in a two-column grid, 24px gap; one column under 960px. Card padding 40px desktop, 24px phone.
- Phone: the sidebar becomes a top bar with a menu; nothing scrolls sideways at 360px.

## Shape and depth

- Radius: cards 16px, inset panels and tables 8px, buttons, inputs and chips 6px.
- No shadows on cards. One shadow, for floating layers only (dialog, toast, menu).

## Components

- **Buttons.** Primary: `primary` fill, `on-primary` label, one per view. Secondary: `surface` fill, 1px `border-strong`, `text` label. Quiet: text only. Labels in Montserrat SemiBold at `body` size (16px).
- **Chips.** `surface-inset` fill, `text` label, 6px radius. A status chip adds a status dot.
- **Window meter.** A row of vertical ticks, one per sub-bucket of the rolling window (12), filled in `primary` up to usage, with the cap marked as a `tripped` tick. Borrowed from Parallel's progress bar.
- **Step timeline.** A vertical line with a node per stage, for a hold's life (queued, frozen, released or rejected, claimed) and a timelocked change (proposed, waiting, executable, executed or vetoed).
- **Tables.** `surface-inset` header with Montserrat labels, hairline rows, an ID column, skeleton bars while loading.
- **Amount.** Tabular figures, token symbol after the number in `text-secondary`.
- **Countdown.** Montserrat Light figures, with the target time beside it in `text-muted`.

## Icons and imagery

- One outline icon set at 1.5px stroke, 20px in nav and 16px inline. Proposed: Lucide (`lucide-react`), to be confirmed when step 1.3 adds it.
- No illustrations or photos. Diagrams of the gate are drawn as simple line art in `text` and `border`.

## Words

Sentence case for headings, buttons and copy. Buttons name the action ("Freeze hold", "Propose change"), and the toast repeats it ("Hold frozen").
