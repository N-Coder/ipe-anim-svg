import xml.etree.ElementTree as ET
import json
import sys
import os

def parse_ipe(ipe_file):
    if not os.path.exists(ipe_file):
        print(f"Error: File {ipe_file} not found.", file=sys.stderr)
        sys.exit(1)

    try:
        tree = ET.parse(ipe_file)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"Error parsing XML: {e}", file=sys.stderr)
        sys.exit(1)

    pages_info = []

    # Ipe files have <page> elements directly under <ipe> root
    for page in root.findall('page'):
        # Layer names in this page
        layers = [layer.get('name') for layer in page.findall('layer')]

        # Views mapping to visible layers
        views = {}
        for i, view in enumerate(page.findall('view')):
            visible_layers_str = view.get('layers', '')
            # The 'layers' attribute contains space-separated layer names
            visible_layers = visible_layers_str.split() if visible_layers_str else []
            # Using string keys for the dict as JSON keys must be strings
            views[str(i + 1)] = visible_layers

        page_data = {
            "layers": layers,
            "views": views
        }

        # Optionally add 'section' or other attributes if they exist
        # section = page.get('section')
        # if section:
        #     page_data["section"] = section

        pages_info.append(page_data)

    return pages_info

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python ipe_info.py <path_to_ipe_file>")
        sys.exit(1)

    ipe_path = sys.argv[1]
    result = parse_ipe(ipe_path)
    print(json.dumps(result, indent=2))
