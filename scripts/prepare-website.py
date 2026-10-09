"""Prepare downloads, the sitemap and the sharing image for the static website."""

from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
import re
import sys
from urllib.parse import quote
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


SITE_ORIGIN = "https://rea.tools"
EXAMPLE_FILES = (
    "package.json",
    "main.js",
    "preload.js",
    "renderer.js",
    "csv.js",
    "index.html",
)


class IndexPolicy(HTMLParser):
    """Read indexing directives from the authored HTML head."""

    def __init__(self):
        super().__init__()
        self.in_head = False
        self.noindex = False

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        if tag == "meta" and self.in_head:
            attributes = dict(attrs)
            if (attributes.get("name") or "").lower() in ("robots", "googlebot"):
                directives = re.split(
                    r"[\s,]+", (attributes.get("content") or "").lower()
                )
                self.noindex |= bool(set(directives) & {"noindex", "none"})

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False


def prepare_sitemap(site):
    """Discover HTML routes automatically, excluding pages marked noindex."""
    namespace = "http://www.sitemaps.org/schemas/sitemap/0.9"
    ET.register_namespace("", namespace)
    sitemap = ET.Element(f"{{{namespace}}}urlset")
    for path in sorted(site.rglob("*.html")):
        policy = IndexPolicy()
        policy.feed(path.read_text(encoding="utf-8"))
        if policy.noindex:
            continue
        route = path.relative_to(site).as_posix()
        if path.name == "index.html":
            route = route.removesuffix("index.html")
        entry = ET.SubElement(sitemap, f"{{{namespace}}}url")
        ET.SubElement(
            entry, f"{{{namespace}}}loc"
        ).text = f"{SITE_ORIGIN}/{quote(route, safe='/')}"
    ET.indent(sitemap, space="  ")
    ET.ElementTree(sitemap).write(
        site / "sitemap.xml", encoding="utf-8", xml_declaration=True
    )
    print(f"Prepared sitemap.xml ({len(sitemap)} indexable pages).")


def prepare_sharing_image(site):
    """Rasterize the maintained SVG for clients that need a PNG preview."""
    try:
        import cairosvg
    except (ImportError, OSError) as error:
        sys.exit(
            f"Cannot prepare sharing image: {error}. Install website/requirements.txt and native Cairo; see website/README.md."
        )
    source = site / "assets/social-card.svg"
    destination = site / "assets/social-card.png"
    cairosvg.svg2png(
        url=str(source), write_to=str(destination), output_width=1200, output_height=630
    )
    print("Prepared assets/social-card.png (1200 × 630).")


def prepare_notes_example(site):
    """Create a ZIP with public source only and reproducible metadata."""
    source = site / "examples/notes-electron"
    contents = BytesIO()
    with ZipFile(contents, "w") as archive:
        for name in EXAMPLE_FILES:
            entry = ZipInfo(f"notes-example/{name}", (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(
                entry,
                (source / name).read_bytes(),
                compress_type=ZIP_DEFLATED,
                compresslevel=9,
            )
    destination = site / "examples/notes-example.zip"
    destination.write_bytes(contents.getvalue())
    print(f"Prepared examples/notes-example.zip ({len(EXAMPLE_FILES)} files).")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    site = root / "website/public"
    prepare_sharing_image(site)
    prepare_sitemap(site)
    prepare_notes_example(site)
