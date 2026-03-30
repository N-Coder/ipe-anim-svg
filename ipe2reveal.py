#!/usr/bin/env python3
"""
ipe2reveal.py — Convert an Ipe presentation to a reveal.js HTML presentation.

Usage:
    python3 ipe2reveal.py <input.ipe> <output_dir> [--ipe-svg PATH]
    python3 ipe2reveal.py <input.ipe> <output.html> --standalone [--ipe-svg PATH]

Steps:
  1. Parse the .ipe file to extract page/layer/view metadata.
  2. For each page, call ipe_svg --page N to render an SVG, then apply class
     tags and post-process the result.
  3. Multi-file mode: write ipe-meta.json (fetched by plugin) and a
     user-editable presentation.html skeleton; copy ipe-layers.js.
     Standalone mode: write a single self-contained HTML file with SVGs and
     ipe-meta embedded inline, ipe-layers.js inlined in a <script> tag.
  4. If presentation.html already exists it is never overwritten; differences
     are reported instead.
"""

import argparse
import difflib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


# ---------------------------------------------------------------------------
# 1. Ipe metadata parsing
# ---------------------------------------------------------------------------

def parse_ipe(ipe_file: str) -> tuple[str, list[dict]]:
    """
    Parse an Ipe file and return (presentation_title, pages).

    Each page dict:
        title  : str  — page title (may contain LaTeX, may be empty)
        layers : list[str]
        views  : list[list[str]]  — views[0] = layer names visible in view 1
    """
    tree = ET.parse(ipe_file)
    root = tree.getroot()

    info = root.find('info')
    pres_title = info.get('title', '') if info is not None else ''

    pages = []
    for page_el in root.findall('page'):
        title = page_el.get('title', '')
        layers = [el.get('name', '') for el in page_el.findall('layer')]

        view_els = page_el.findall('view')
        if view_els:
            views = []
            for view_el in view_els:
                vis_str = view_el.get('layers', '')
                views.append(vis_str.split() if vis_str else [])
        else:
            # No explicit views → one implicit view showing all layers
            views = [list(layers)]

        note_el = page_el.find('notes')
        notes = (note_el.text or '').strip() if note_el is not None else ''

        pages.append({'title': title, 'layers': layers, 'views': views,
                      'notes': notes})

    return pres_title, pages


# ---------------------------------------------------------------------------
# 2. SVG rendering (calls ipe_svg binary)
# ---------------------------------------------------------------------------

def render_page(ipe_svg_bin: str, ipe_file: str, out_svg: str,
                page_num: int) -> list[str]:
    """
    Run `ipe_svg <ipe_file> <out_svg> --page <page_num>`.
    Returns the filtered per-object tag lines from stdout.
    """
    result = subprocess.run(
        [ipe_svg_bin, ipe_file, out_svg, '--page', str(page_num)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f'  Warning: ipe_svg exited {result.returncode} for page {page_num}',
              file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)

    return [
        l for l in (line.strip() for line in result.stdout.splitlines()) if l
    ]


# ---------------------------------------------------------------------------
# 3. Apply class tags (adapted from apply_classes.py)
# ---------------------------------------------------------------------------

def apply_classes(svg_content: str, tag_lines: list[str]) -> str:
    """
    Apply per-object class tags to SVG elements and wrap them in a single
    top-level <g class="ipe-page"> group.  Returns the modified SVG string.
    """
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')

    root = ET.fromstring(svg_content)
    ns = {'svg': 'http://www.w3.org/2000/svg'}

    page_set = (root.find('.//svg:pageSet', ns)
                or root.find('.//pageSet'))

    if page_set is not None:
        # Multi-object case: Cairo produced <pageSet><page>…</page>…</pageSet>.
        # Each <page> corresponds to one rendered Ipe object / flush_object call.
        page_els = list(page_set)
        if len(page_els) != len(tag_lines):
            print(f'  Warning: {len(page_els)} SVG objects vs '
                  f'{len(tag_lines)} tag lines.', file=sys.stderr)

        processed = []
        for page_el, tags in zip(page_els, tag_lines):
            children = list(page_el)
            if len(children) > 1:
                page_el.tag = '{http://www.w3.org/2000/svg}g'
                page_el.set('class', tags)
                processed.append(page_el)
            elif len(children) == 1:
                child = children[0]
                child.set('class', tags)
                processed.append(child)
            # empty: skip

        # Replace pageSet with a flat <g class="ipe-page"> containing all objects
        page_set.tag = '{http://www.w3.org/2000/svg}g'
        page_set.set('class', 'ipe-page')
        page_set.clear()
        for obj in processed:
            page_set.append(obj)
    else:
        # No <pageSet>: Cairo rendered 0 or 1 cairo_show_page calls, so content
        # sits directly in the SVG root (no multi-page wrapper).  The non-defs
        # children together represent a single rendered object (if any).
        # IMPORTANT: use root.remove() — not root.clear() — to preserve root
        # attributes (viewBox, width, height) set by the Cairo surface size.
        defs_tags = {'{http://www.w3.org/2000/svg}defs', 'defs'}
        content_children = [c for c in root if c.tag not in defs_tags]
        defs_children    = [c for c in root if c.tag in defs_tags]

        for child in list(root):
            root.remove(child)

        for d in defs_children:
            root.append(d)

        wrapper = ET.SubElement(root, '{http://www.w3.org/2000/svg}g')
        wrapper.set('class', 'ipe-page')

        if content_children and tag_lines:
            if len(content_children) == 1:
                content_children[0].set('class', tag_lines[0])
                wrapper.append(content_children[0])
            else:
                g = ET.SubElement(wrapper, '{http://www.w3.org/2000/svg}g')
                g.set('class', tag_lines[0])
                for el in content_children:
                    g.append(el)
        # Empty page (no content_children or no tag_lines): wrapper stays empty.

    buf = io.BytesIO()
    ET.ElementTree(root).write(buf, encoding='utf-8', xml_declaration=True)
    return buf.getvalue().decode('utf-8')


# ---------------------------------------------------------------------------
# 4. SVG post-processing
# ---------------------------------------------------------------------------

def postprocess_svg(svg_content: str) -> str:
    """
    Ensure the SVG has a viewBox, then set width/height to 100% so it
    scales to fill a reveal.js slide.
    """
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')

    root = ET.fromstring(svg_content)

    if not root.get('viewBox'):
        def strip_unit(val: str) -> float:
            return float(re.sub(r'[a-zA-Z%]+$', '', val.strip()) or '0')

        w = strip_unit(root.get('width', '0'))
        h = strip_unit(root.get('height', '0'))
        root.set('viewBox', f'0 0 {w:g} {h:g}')

    root.set('width', '100%')
    root.set('height', '100%')

    buf = io.BytesIO()
    ET.ElementTree(root).write(buf, encoding='utf-8', xml_declaration=True)
    return buf.getvalue().decode('utf-8')


# ---------------------------------------------------------------------------
# 4b. SVG ID prefixing (for standalone inline embedding)
# ---------------------------------------------------------------------------

def prefix_svg_ids(svg_content: str, prefix: str) -> str:
    """
    Prefix every id="..." in svg_content with '<prefix>--' and rewrite all
    internal url(#...) and href="#..." references accordingly.
    Mirrors the prefixIds() function in ipe-layers.js.
    """
    ids = set(re.findall(r'\bid="([^"]+)"', svg_content))
    if not ids:
        return svg_content

    svg_content = re.sub(
        r'\bid="([^"]+)"',
        lambda m: f'id="{prefix}--{m.group(1)}"',
        svg_content)
    svg_content = re.sub(
        r'url\(#([^)]+)\)',
        lambda m: (f'url(#{prefix}--{m.group(1)})'
                   if m.group(1) in ids else m.group(0)),
        svg_content)
    svg_content = re.sub(
        r'((?:xlink:)?href)="#([^"]+)"',
        lambda m: (f'{m.group(1)}="#{prefix}--{m.group(2)}"'
                   if m.group(2) in ids else m.group(0)),
        svg_content)
    return svg_content


# ---------------------------------------------------------------------------
# 5. Generate ipe-meta.json
# ---------------------------------------------------------------------------

def build_meta(pages: list[dict], filenames: list[str]) -> dict:
    meta_pages = []
    for i, (page, fname) in enumerate(zip(pages, filenames), start=1):
        meta_pages.append({
            'index': i,
            'title': page['title'],
            'file': fname,
            'layers': ' '.join(page['layers']),
            'views': [' '.join(v) for v in page['views']],
        })
    return {'pages': meta_pages}


# ---------------------------------------------------------------------------
# 6. Generate HTML skeleton
# ---------------------------------------------------------------------------

REVEAL_CDN = 'https://cdn.jsdelivr.net/npm/reveal.js@6'


def _esc(s: str) -> str:
    return (s.replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;'))


def generate_html(pres_title: str, pages: list[dict], meta: dict,
                  standalone: bool = False,
                  svg_contents: list[str] | None = None,
                  ipe_layers_js: str | None = None) -> str:
    """
    Generate the presentation HTML.

    standalone=True:  single self-contained file — SVGs embedded in sections,
                      ipe-meta inlined, ipe-layers.js inlined.
    standalone=False: multi-file skeleton — sections are empty placeholders,
                      ipe-meta is fetched from ipe-meta.json at runtime,
                      ipe-layers.js referenced as an external file.
    """
    # Build <section> elements
    section_lines = []
    for i, page in enumerate(pages, start=1):
        comment = f'  <!-- {_esc(page["title"])} -->' if page['title'] else ''
        notes_block = ''
        if page['notes']:
            notes_block = f'\n      <aside class="notes">{_esc(page["notes"])}</aside>\n    '

        if standalone and svg_contents is not None:
            svg = svg_contents[i - 1]
            svg = re.sub(r'<\?xml[^?]*\?>\s*', '', svg)   # strip XML declaration
            section_lines.append(
                f'    <section data-ipe-page="{i}">{comment}\n{svg}{notes_block}</section>')
        elif page['notes']:
            section_lines.append(
                f'    <section data-ipe-page="{i}">{comment}\n{notes_block}</section>')
        else:
            section_lines.append(
                f'    <section data-ipe-page="{i}"></section>{comment}')
    sections_html = '\n'.join(section_lines)

    # ipe-meta block — inline only in standalone mode
    if standalone:
        meta_json = json.dumps(meta, indent=4, ensure_ascii=False)
        meta_indented = '\n'.join('  ' + line for line in meta_json.splitlines())
        meta_block = f"""\
<!--
  ipe-meta is read by ipe-layers.js. It is regenerated by ipe2reveal.py and
  not meant for hand-editing. Adjust the <section> elements above instead.
-->
<script type="application/json" id="ipe-meta">
{meta_indented}
</script>

"""
    else:
        meta_block = ''

    # ipe-layers.js — inline for standalone, external for multi-file
    if standalone and ipe_layers_js:
        layers_script = f'<script>\n{ipe_layers_js}\n</script>'
    else:
        layers_script = f'<script src="ipe-layers.js"></script>'

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{_esc(pres_title) or 'Presentation'}</title>
  <link rel="stylesheet" href="{REVEAL_CDN}/dist/reveal.css">
  <link rel="stylesheet" href="{REVEAL_CDN}/dist/theme/white.css">
  <style>
    /* Fade transitions for Ipe layer elements */
    [data-ipe-layer] {{ transition: opacity 0.3s ease; }}
  </style>
</head>
<body>

<div class="reveal">
  <div class="slides">

{sections_html}

  </div>
</div>

{meta_block}<script src="{REVEAL_CDN}/dist/reveal.js"></script>
<script src="{REVEAL_CDN}/dist/plugin/notes.js"></script>
{layers_script}
<script>
Reveal.initialize({{
  hash: true,
  transition: 'fade',
  plugins: [RevealNotes, IpeLayers],
}});
</script>

</body>
</html>
"""


# ---------------------------------------------------------------------------
# 7. HTML diff reporting
# ---------------------------------------------------------------------------

def _extract_slides_block(html: str) -> str:
    """Return the content of the <div class="slides">…</div> block."""
    m = re.search(r'(<div class="slides">.*?</div>\s*</div>)', html, re.DOTALL)
    return m.group(1) if m else ''


def _extract_meta_block(html: str) -> str:
    """Return the <script … id="ipe-meta">…</script> block, or empty string."""
    m = re.search(
        r'(<script type="application/json" id="ipe-meta">.*?</script>)',
        html, re.DOTALL)
    return m.group(1) if m else ''


def report_html_diff(existing_html: str, new_html: str, html_path: Path) -> None:
    """
    Compare existing and new HTML; print differences and warn that the file
    was not overwritten.  Returns without writing anything.
    """
    old_slides = _extract_slides_block(existing_html)
    new_slides = _extract_slides_block(new_html)
    old_meta   = _extract_meta_block(existing_html)
    new_meta   = _extract_meta_block(new_html)

    slides_diff = list(difflib.unified_diff(
        old_slides.splitlines(keepends=True),
        new_slides.splitlines(keepends=True),
        fromfile='slides (existing)',
        tofile='slides (new)',
        n=2,
    ))
    meta_diff = list(difflib.unified_diff(
        old_meta.splitlines(keepends=True),
        new_meta.splitlines(keepends=True),
        fromfile='ipe-meta (existing)',
        tofile='ipe-meta (new)',
        n=2,
    ))

    if not slides_diff and not meta_diff:
        print(f'{html_path}: up to date (not overwritten).')
        return

    print(f'{html_path}: already exists — not overwritten. Differences:')
    if slides_diff:
        print(''.join(slides_diff), end='')
    if meta_diff:
        print(''.join(meta_diff), end='')
    print(f'Delete {html_path} and re-run to regenerate.')


# ---------------------------------------------------------------------------
# 8. Main
# ---------------------------------------------------------------------------

def find_ipe_svg(script_dir: Path) -> str | None:
    candidates = [
        script_dir / 'build' / 'ipe_svg',
        script_dir / 'cmake-build-debug' / 'ipe_svg',
        Path('build') / 'ipe_svg',
        Path('cmake-build-debug') / 'ipe_svg',
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Convert an Ipe presentation to a reveal.js HTML presentation.')
    parser.add_argument('ipe_file', help='Input .ipe file')
    parser.add_argument('output_dir',
                        help='Output directory (multi-file) or .html path (--standalone)')
    parser.add_argument('--ipe-svg', default=None, metavar='PATH',
                        help='Path to the ipe_svg binary (auto-detected if omitted)')
    parser.add_argument('--standalone', action='store_true',
                        help=('Generate a single self-contained HTML file with SVGs '
                              'and ipe-layers.js embedded inline (file:// hostable). '
                              'output_dir is treated as the output .html path.'))
    args = parser.parse_args()

    ipe_file = args.ipe_file

    # Standalone: output_dir is the HTML file path; multi-file: it's a directory
    if args.standalone:
        html_path = Path(args.output_dir)
        if html_path.suffix.lower() != '.html':
            html_path = html_path.with_suffix('.html')
        out_dir = html_path.parent
    else:
        out_dir = Path(args.output_dir)
        html_path = out_dir / 'presentation.html'

    out_dir.mkdir(parents=True, exist_ok=True)

    # Locate ipe_svg binary
    ipe_svg_bin = args.ipe_svg
    if ipe_svg_bin is None:
        ipe_svg_bin = find_ipe_svg(Path(__file__).parent)
    if ipe_svg_bin is None:
        sys.exit('Error: ipe_svg binary not found. '
                 'Build the project first, or pass --ipe-svg PATH.')
    print(f'Using ipe_svg: {ipe_svg_bin}')

    # Parse Ipe document
    print(f'Parsing {ipe_file} ...')
    pres_title, pages = parse_ipe(ipe_file)
    n = len(pages)
    print(f'  {n} page(s) found.')

    pad = len(str(n))
    filenames = [f'page-{str(i + 1).zfill(pad)}.svg' for i in range(n)]

    # Render, apply classes, post-process each page
    svg_contents: list[str] = []
    for i, (page, fname) in enumerate(zip(pages, filenames), start=1):
        label = f'"{page["title"]}"' if page['title'] else '(untitled)'
        print(f'  Page {i}/{n} {label} ...')

        raw_path   = out_dir / f'_raw_{fname}'
        final_path = out_dir / fname

        tag_lines = render_page(ipe_svg_bin, ipe_file, str(raw_path), i)
        raw_svg   = raw_path.read_text(encoding='utf-8')
        processed = apply_classes(raw_svg, tag_lines)
        final_svg = postprocess_svg(processed)
        raw_path.unlink()

        if args.standalone:
            svg_contents.append(final_svg)
        else:
            final_path.write_text(final_svg, encoding='utf-8')

    # Build metadata
    meta = build_meta(pages, filenames)

    # Multi-file: write ipe-meta.json (fetched at runtime by the plugin)
    # Standalone: ipe-meta is embedded inline; no separate file needed
    if not args.standalone:
        meta_path = out_dir / 'ipe-meta.json'
        meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                             encoding='utf-8')
        print(f'Wrote {meta_path}')

    # Locate ipe-layers.js source
    src_js = Path(__file__).parent / 'ipe-layers.js'

    # Build the HTML
    if args.standalone:
        if not src_js.exists():
            sys.exit(f'Error: ipe-layers.js not found at {src_js}')
        ipe_layers_js = src_js.read_text(encoding='utf-8')
        prefixed_svgs = [
            prefix_svg_ids(svg, f'p{i + 1}')
            for i, svg in enumerate(svg_contents)
        ]
        html = generate_html(pres_title, pages, meta,
                             standalone=True,
                             svg_contents=prefixed_svgs,
                             ipe_layers_js=ipe_layers_js)
    else:
        html = generate_html(pres_title, pages, meta)

    # Write HTML — but never overwrite an existing file; report differences
    if html_path.exists():
        existing_html = html_path.read_text(encoding='utf-8')
        report_html_diff(existing_html, html, html_path)
    else:
        html_path.write_text(html, encoding='utf-8')
        print(f'Wrote {html_path}')

    # Multi-file: copy ipe-layers.js into output directory
    if not args.standalone:
        dst_js = out_dir / 'ipe-layers.js'
        if src_js.exists():
            shutil.copy2(str(src_js), str(dst_js))
            print(f'Copied ipe-layers.js → {dst_js}')
        else:
            print(f'Warning: ipe-layers.js not found at {src_js}; '
                  f'copy it manually to {out_dir}.', file=sys.stderr)

    print('Done.')


if __name__ == '__main__':
    main()
