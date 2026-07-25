// Shared helpers for the AI Datacenter Network Engineer training guide.

#let accent = rgb("#1a5276")
#let warnbg = rgb("#fdf2e3")
#let saybg = rgb("#e8f1f8")
#let keybg = rgb("#eef7ee")

// "Say this in the interview" callout — a concise, senior-sounding talking point.
#let soundbite(body) = block(
  fill: saybg,
  stroke: (left: 3pt + accent),
  inset: (x: 10pt, y: 8pt),
  radius: 2pt,
  width: 100%,
  [#text(fill: accent, weight: "bold", size: 9pt)[INTERVIEW SOUNDBITE] \ #body],
)

// Operational gotcha / failure-mode callout.
#let gotcha(body) = block(
  fill: warnbg,
  stroke: (left: 3pt + rgb("#b9770e")),
  inset: (x: 10pt, y: 8pt),
  radius: 2pt,
  width: 100%,
  [#text(fill: rgb("#b9770e"), weight: "bold", size: 9pt)[FIELD GOTCHA] \ #body],
)

// Key concept box.
#let keyidea(body) = block(
  fill: keybg,
  stroke: (left: 3pt + rgb("#1e8449")),
  inset: (x: 10pt, y: 8pt),
  radius: 2pt,
  width: 100%,
  [#text(fill: rgb("#1e8449"), weight: "bold", size: 9pt)[KEY CONCEPT] \ #body],
)

// Interview Q&A block.
#let qa(question, answer) = block(
  breakable: true,
  inset: (y: 4pt),
  [
    #block(fill: rgb("#f2f3f4"), inset: 8pt, radius: 2pt, width: 100%,
      [#text(weight: "bold")[Q: #question]])
    #block(inset: (left: 8pt, top: 2pt), [*A:* #answer])
  ],
)

// Compact definition row for glossary.
#let gterm(term, def) = [#text(weight: "bold")[#term] --- #def]
