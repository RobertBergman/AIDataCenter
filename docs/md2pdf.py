#!/usr/bin/env python3
"""Convert project Markdown documentation to Typst and PDF.

Usage:
    python3 docs/md2pdf.py            # convert all registered docs
    python3 docs/md2pdf.py docs/build-guide.md README.md

Requires:
    - pandoc (e.g. `pip install pypandoc-binary`)
    - typst CLI on PATH

Outputs `<name>.typ` + `<name>.pdf` next to each source `.md`.
Edit the Markdown, then re-run — generated .typ files are overwritten.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "docs" / "template.typ"

# (markdown path, kicker line, revision string)
DOCS: list[tuple[str, str, str]] = [
    ("SPEC.md", "AIDATACENTER — SPECIFICATION", "1.3 · 2026-07-19"),
    ("docs/network.md", "AIDATACENTER — NETWORK / ZTP / ROCE", "0.2 · 2026-07-19"),
    ("docs/overlay.md", "AIDATACENTER — OVERLAY / EVPN-VXLAN", "0.1 · 2026-07-19"),
    ("docs/serving.md", "AIDATACENTER — SERVING / API ACCESS", "0.1 · 2026-07-19"),
    ("docs/build-guide.md", "AIDATACENTER — BUILD GUIDE", "0.2 · 2026-07-19"),
    ("docs/bootstrap.md", "AIDATACENTER — BOOTSTRAP STACK", "0.1 · 2026-07-18"),
    ("docs/netbox.md", "AIDATACENTER — SOURCE OF TRUTH", "0.1 · 2026-07-18"),
    ("docs/cabling.md", "AIDATACENTER — CABLING GUIDE", "0.2 · 2026-07-19"),
    ("README.md", "AIDATACENTER — OVERVIEW", "2026-07-18"),
    ("bootstrap/README.md", "AIDATACENTER — BOOTSTRAP STACK", "2026-07-18"),
    ("demo/README.md", "AIDATACENTER — DEMO", "2026-07-18"),
]

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
NUM_PREFIX = re.compile(r"^\d+[A-Z]?(\.\d+)*\.?\s+")


def preprocess(md_text: str) -> tuple[str, str]:
    """Return (title, body_md).

    - First H1 becomes the PDF title (removed from body)
    - Remaining headings demoted one level (## → #) so Typst numbering matches
    - Manual numeric prefixes stripped from heading text (Typst re-numbers)
    - Relative *.md links rewritten to *.pdf
    """
    title = "AIDataCenter"
    out: list[str] = []
    title_done = False
    in_code = False
    for line in md_text.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            out.append(line)
            continue
        m = HEADING.match(line)
        if m and not in_code:
            hashes, text = m.groups()
            if not title_done and len(hashes) == 1:
                title = text.strip()
                title_done = True
                continue
            # demote one level, strip manual numbering
            level = max(1, len(hashes) - 1)
            text = NUM_PREFIX.sub("", text.strip())
            out.append("#" * level + " " + text)
            continue
        if not in_code:
            # links: ](foo.md) or ](foo.md#anchor) → ](foo.pdf)
            line = re.sub(r"(\]\([^)]*?)\.md(#[^)]*)?\)", r"\1.pdf)", line)
        out.append(line)
    return title, "\n".join(out)


def convert(md_path: Path, kicker: str, rev: str) -> Path:
    import pypandoc  # bundled pandoc (pypandoc-binary) or system

    rel = md_path.relative_to(REPO)
    title, body_md = preprocess(md_path.read_text(encoding="utf-8"))

    body_typ = pypandoc.convert_text(body_md, "typst", format="markdown")

    # relative import path from the .typ location to docs/template.typ
    import_path = (
        Path(*[".."] * (len(rel.parts) - 1)) / "docs" / "template.typ"
        if len(rel.parts) > 1
        else Path("docs") / "template.typ"
    )

    typ_path = md_path.with_suffix(".typ")
    typ_path.write_text(
        f"// GENERATED from {rel} — do not edit. Regenerate: python3 docs/md2pdf.py\n"
        f'#import "{import_path}": *\n'
        f'#show: doc.with(title: "{title}", kicker: "{kicker}", rev: "{rev}")\n\n'
        + body_typ
        + "\n",
        encoding="utf-8",
    )

    pdf_path = md_path.with_suffix(".pdf")
    subprocess.run(
        ["typst", "compile", "--root", str(REPO), str(typ_path), str(pdf_path)],
        check=True,
        cwd=REPO,
    )
    print(f"✔ {rel} → {pdf_path.relative_to(REPO)}")
    return pdf_path


def main(argv: list[str]) -> int:
    if argv:
        docs = []
        for a in argv:
            p = Path(a)
            match = [d for d in DOCS if d[0] == str(p).replace("\\", "/")]
            docs.append(match[0] if match else (str(p), "AIDATACENTER", "2026-07-18"))
    else:
        docs = DOCS

    failed = 0
    for rel, kicker, rev in docs:
        md_path = REPO / rel
        if not md_path.exists():
            print(f"✘ missing: {rel}", file=sys.stderr)
            failed += 1
            continue
        try:
            convert(md_path, kicker, rev)
        except Exception as e:  # noqa: BLE001
            print(f"✘ {rel}: {e}", file=sys.stderr)
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
