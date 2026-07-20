// Shared Typst template for AIDataCenter documentation PDFs.
// Used by docs/md2pdf.py — do not edit generated .typ files; edit this instead.
//
// Usage:
//   #import "template.typ": *
//   #show: doc.with(title: "...", kicker: "...", rev: "0.1 · 2026-07-18")

// pandoc's typst writer emits #horizontalrule for "---" — define it.
#let horizontalrule = [
  #v(0.5em)
  #line(length: 100%, stroke: 0.4pt + luma(180))
  #v(0.5em)
]

#let doc(title: "", kicker: "AIDATACENTER — 64× B200", rev: "", body) = {
  set document(
    title: title,
    author: "Infrastructure / AI Platform",
    date: datetime(year: 2026, month: 7, day: 18),
  )

  set page(
    paper: "us-letter",
    margin: (x: 0.85in, y: 0.8in),
    header: context {
      if counter(page).get().first() > 1 {
        set text(size: 8.5pt, fill: luma(90))
        grid(
          columns: (1fr, auto),
          [#title],
          [AIDataCenter — Internal],
        )
        v(-0.3em)
        line(length: 100%, stroke: 0.4pt + luma(180))
      }
    },
    footer: context {
      set text(size: 8.5pt, fill: luma(90))
      line(length: 100%, stroke: 0.4pt + luma(180))
      v(-0.3em)
      grid(
        columns: (1fr, auto, 1fr),
        [Rev #rev],
        align(center)[Page #counter(page).display("1 of 1", both: true)],
        align(right)[Typst],
      )
    },
  )

  set text(font: ("New Computer Modern", "DejaVu Serif"), size: 10pt)
  set par(justify: true, leading: 0.65em)
  set heading(numbering: "1.1")

  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    v(0.4em)
    block(below: 0.8em)[
      #set text(size: 14pt, weight: "bold")
      #counter(heading).display() #h(0.4em) #it.body
    ]
    line(length: 100%, stroke: 0.8pt + rgb("#1a365d"))
    v(0.4em)
  }
  show heading.where(level: 2): it => {
    v(0.6em)
    block(below: 0.5em)[
      #set text(size: 11.5pt, weight: "bold", fill: rgb("#1a365d"))
      #counter(heading).display() #h(0.35em) #it.body
    ]
  }
  show heading.where(level: 3): it => {
    v(0.4em)
    block(below: 0.4em)[
      #set text(size: 10.5pt, weight: "bold")
      #counter(heading).display() #h(0.3em) #it.body
    ]
  }

  set table(stroke: 0.4pt + luma(160), inset: 6pt, align: left)
  show table.cell.where(y: 0): set text(weight: "bold", size: 9pt)
  show table: set text(size: 9pt)

  // pandoc wraps every table in #figure(kind: table); figure blocks are
  // unbreakable, so tables longer than a page overlap rows at the page
  // bottom instead of splitting. Show-set restores breakability.
  // NOTE: must live INSIDE doc() — show rules in an imported module do
  // not leak into the importing document.
  show figure.where(kind: table): set block(breakable: true)

  show raw.where(block: true): it => block(
    width: 100%,
    fill: luma(245),
    inset: 10pt,
    radius: 3pt,
    stroke: 0.4pt + luma(200),
    text(font: "DejaVu Sans Mono", size: 7.8pt, it),
  )
  show link: set text(fill: rgb("#1a365d"))

  // ── Title block (compact) ─────────────────────────────────────────
  align(center)[
    #v(1.1in)
    #text(size: 11pt, fill: luma(80), tracking: 1.5pt)[#kicker]
    #v(0.5em)
    #line(length: 40%, stroke: 1.2pt + rgb("#1a365d"))
    #v(0.7em)
    #text(size: 20pt, weight: "bold")[#title]
    #v(0.6em)
    #line(length: 40%, stroke: 0.6pt + luma(160))
    #v(0.8em)
    #text(size: 9.5pt, fill: luma(90))[
      Rev #rev\
      Generated from Markdown — edit the `.md` source and regenerate (`python3 docs/md2pdf.py`)
    ]
  ]
  pagebreak()

  text(size: 14pt, weight: "bold")[Contents]
  v(0.6em)
  outline(title: none, indent: 1.2em, depth: 2)

  body
}
