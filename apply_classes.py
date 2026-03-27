import sys
import xml.etree.ElementTree as ET
import re

def main():
    if len(sys.argv) < 3:
        print("Usage: python apply_classes.py <input.svg> <tags.txt> [output.svg]")
        sys.exit(1)

    input_svg = sys.argv[1]
    tags_file = sys.argv[2]
    output_svg = sys.argv[3] if len(sys.argv) > 3 else input_svg

    # Register SVG namespace
    ET.register_namespace('', "http://www.w3.org/2000/svg")
    ET.register_namespace('xlink', "http://www.w3.org/1999/xlink")

    try:
        tree = ET.parse(input_svg)
    except Exception as e:
        print(f"Error parsing SVG: {e}")
        sys.exit(1)

    root = tree.getroot()
    ns = {'svg': 'http://www.w3.org/2000/svg'}

    # Find pageSet
    page_set = root.find('.//svg:pageSet', ns)
    if page_set is None:
        page_set = root.find('.//pageSet')

    if page_set is None:
        print("Error: <pageSet> not found in SVG.")
        sys.exit(1)

    pages = list(page_set) # All children should be <page> elements

    with open(tags_file, 'r') as f:
        tag_lines = [line.strip() for line in f if line.strip() and not line.startswith("No text objects") and not line.startswith("Freetype engine")]

    if len(pages) != len(tag_lines):
        print(f"Warning: Number of <page> elements ({len(pages)}) does not match number of tag lines ({len(tag_lines)})")

    processed_objects = []

    for page, tags in zip(pages, tag_lines):
        children = list(page)
        if len(children) > 1:
            # Convert to group
            page.tag = '{http://www.w3.org/2000/svg}g'
            page.set('class', tags)
            processed_objects.append(page)
        elif len(children) == 1:
            # Apply to single child and drop page
            child = children[0]
            child.set('class', tags)
            processed_objects.append(child)
        else:
            # Empty page?
            continue

    # Regroup objects into new page objects based on page-X class
    new_pages = []
    current_page_el = None
    current_page_num = None

    page_regex = re.compile(r'page-(\d+)')

    for obj in processed_objects:
        tags = obj.get('class', '')
        match = page_regex.search(tags)
        page_num = match.group(1) if match else "unknown"

        if page_num != current_page_num:
            current_page_num = page_num
            current_page_el = ET.Element('{http://www.w3.org/2000/svg}page')
            new_pages.append(current_page_el)

        current_page_el.append(obj)

    # Replace old page_set content with new_pages
    # We clear page_set and add new_pages
    page_set.clear()
    page_set.text = "\n"
    for p in new_pages:
        p.tail = "\n"
        page_set.append(p)

    tree.write(output_svg, encoding='utf-8', xml_declaration=True)
    print(f"Successfully processed {len(pages)} objects into {len(new_pages)} new pages in {output_svg}")

if __name__ == "__main__":
    main()
