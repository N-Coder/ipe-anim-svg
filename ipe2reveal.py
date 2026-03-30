#!/usr/bin/env python3
"""
ipe2reveal.py — Convert an Ipe presentation to a reveal.js HTML presentation.

Usage:
    python3 ipe2reveal.py <input.ipe> <output_dir> [--ipe-svg PATH]

Steps:
  1. Parse the .ipe file to extract page/layer/view metadata.
  2. For each page, call ipe_svg --page N to render an SVG, then apply class
     tags and post-process the result.
  3. Write ipe-meta.json (consumed by the plugin) and a user-editable
     presentation.html skeleton.
  4. Copy ipe-layers.js into the output directory.
"""

import argparse
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


def generate_html(pres_title: str, pages: list[dict], meta: dict) -> str:
    # One <section> per page; title as inline comment for readability
    section_lines = []
    for i, page in enumerate(pages, start=1):
        comment = f'  <!-- {_esc(page["title"])} -->' if page['title'] else ''
        if page['notes']:
            notes_html = _esc(page['notes'])
            inner = f'      <aside class="notes">{notes_html}</aside>\n    '
            section_lines.append(
                f'    <section data-ipe-page="{i}">{comment}\n{inner}</section>')
        else:
            section_lines.append(
                f'    <section data-ipe-page="{i}"></section>{comment}')
    sections_html = '\n'.join(section_lines)

    meta_json = json.dumps(meta, indent=4, ensure_ascii=False)
    meta_indented = '\n'.join('  ' + line for line in meta_json.splitlines())

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

<!--
  ipe-meta is read by ipe-layers.js. It is regenerated by ipe2reveal.py and
  not meant for hand-editing. Adjust the <section> elements above instead.
-->
<script type="application/json" id="ipe-meta">
{meta_indented}
</script>

<script src="{REVEAL_CDN}/dist/reveal.js"></script>
<script src="{REVEAL_CDN}/dist/plugin/notes.js"></script>
<script src="ipe-layers.js"></script>
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
# 7. Main
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
    parser.add_argument('output_dir', help='Output directory')
    parser.add_argument('--ipe-svg', default=None, metavar='PATH',
                        help='Path to the ipe_svg binary (auto-detected if omitted)')
    args = parser.parse_args()

    ipe_file = args.ipe_file
    out_dir = Path(args.output_dir)
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
    for i, (page, fname) in enumerate(zip(pages, filenames), start=1):
        label = f'"{page["title"]}"' if page['title'] else f'(untitled)'
        print(f'  Page {i}/{n} {label} ...')

        raw_path = out_dir / f'_raw_{fname}'
        final_path = out_dir / fname

        tag_lines = render_page(ipe_svg_bin, ipe_file, str(raw_path), i)
        raw_svg = raw_path.read_text(encoding='utf-8')
        processed = apply_classes(raw_svg, tag_lines)
        final_svg = postprocess_svg(processed)

        final_path.write_text(final_svg, encoding='utf-8')
        raw_path.unlink()

    # ipe-meta.json
    meta = build_meta(pages, filenames)
    meta_path = out_dir / 'ipe-meta.json'
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                         encoding='utf-8')
    print(f'Wrote {meta_path}')

    # presentation.html
    html = generate_html(pres_title, pages, meta)
    html_path = out_dir / 'presentation.html'
    html_path.write_text(html, encoding='utf-8')
    print(f'Wrote {html_path}')

    # Copy ipe-layers.js
    src_js = Path(__file__).parent / 'ipe-layers.js'
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
