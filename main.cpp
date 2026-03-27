#include "ipecairopainter.h"
#include "ipegroup.h"
#include "ipereference.h"
#include "ipethumbs.h"

#include <cairo-svg.h>
#include <cairo.h>

#include <fstream>
#include <iostream>

using namespace std;
using namespace ipe;

static cairo_status_t stream_writer(void *closure, const unsigned char *data,
                                    unsigned int length) {
  ostream *os = static_cast<ostream *>(closure);
  os->write(reinterpret_cast<const char *>(data), length);
  return os->good() ? CAIRO_STATUS_SUCCESS : CAIRO_STATUS_WRITE_ERROR;
}

void render(ostream &out, Document *iDoc, std::unique_ptr<Fonts> iFonts,
            double tolerance = 0.1, double zoom = 1.0) {
  const Layout *iLayout = iDoc->cascade()->findLayout();
  Vector offset = iLayout->paper().topLeft();
  int wid = static_cast<int>(iLayout->paper().width() * zoom);
  int ht = static_cast<int>(iLayout->paper().height() * zoom);

  cairo_surface_t *surface =
      cairo_svg_surface_create_for_stream(&stream_writer, &out, wid, ht);
  cairo_t *cc = cairo_create(surface);
  cairo_scale(cc, zoom, -zoom);
  cairo_translate(cc, -offset.x, -offset.y);

  cairo_set_tolerance(cc, tolerance);
  CairoPainter painter(iDoc->cascade(), iFonts.get(), cc, zoom, true, true);

  auto flush_object = [&](const vector<string> &classes) {
    for (const auto &s : classes) {
      std::cout << s << " ";
    }
    std::cout << std::endl;
    cairo_surface_flush(surface);
    cairo_show_page(cc);
  };

  for (int i = 0; i < iDoc->countPages(); ++i) {
    Page *page = iDoc->page(i);

    // const auto viewMap = page->viewMap(view, iDoc->cascade());
    // painter.setAttributeMap(&viewMap);
    // std::vector<Matrix> layerMatrices = page->layerMatrices(view);

    painter.pushMatrix();
    string pagename = "page-" + to_string(i);

    // background & title
    {
      // not supported with ipe 7.2.30
      // Attribute bg = page->backgroundSymbol(iDoc->cascade());
      // const Symbol *background = iDoc->cascade()->findSymbol(bg);
      // if (background && page->findLayer("BACKGROUND") < 0) {
      //   painter.drawSymbol(bg);
      //   flush_object({"background", pagename});
      // }

      const Text *title = page->titleText();
      if (title) {
        title->draw(painter);
        flush_object({"title", pagename});
      }
    }

    for (int j = 0; j < page->count(); ++j) {
      int layer = page->layerOf(j);
      Object *obj = page->object(j);

      painter.pushMatrix();
      // painter.transform(layerMatrices[layer]);
      obj->draw(painter);
      painter.popMatrix();

      vector tags{"objnr-" + to_string(j), "layernr-" + to_string(layer),
                  "layer-" + std::string(page->layer(layer).z()), pagename};
      if (obj->getCustom().isString() && !obj->getCustom().string().empty()) {
        tags.push_back("custom-" + std::string(obj->getCustom().string().z()));
      }
      switch (obj->type()) {
      case Object::EGroup:
        tags.emplace_back("type-group");
        break;
      case Object::EImage:
        tags.emplace_back("type-image");
        break;
      case Object::EText: {
        tags.emplace_back("type-text");
        if (obj->asText()->isMinipage()) {
          tags.emplace_back("text-minipage");
        } else {
          tags.emplace_back("text-label");
        }
        auto style = obj->asText()->style();
        if (style.isString()) {
          tags.push_back("text-style-" + std::string(style.string().z()));
        } else if (style.isSymbolic()) {
          tags.push_back(
              "text-style-" +
              std::string(Repository::get()->toString(style.index()).z()));
        }
        break;
      }
      case Object::EPath:
        tags.emplace_back("type-path");
        break;
      case Object::EReference: {
        tags.emplace_back("type-reference");
        auto name = obj->asReference()->name();
        if (name.isString()) {
          tags.push_back("ref-" + std::string(name.string().z()));
        } else if (name.isSymbolic()) {
          tags.push_back(
              "ref-" +
              std::string(Repository::get()->toString(name.index()).z()));
        }
        break;
      }
      }
      flush_object(tags);
    }
    painter.popMatrix();
  }

  cairo_destroy(cc);
  cairo_surface_destroy(surface);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "Usage: " << argv[0] << " <input.ipe> <output.svg>"
              << std::endl;
    return 1;
  }

  const char *inputFile = argv[1];
  const char *outputFile = argv[2];

  Platform::initLib(IPELIB_VERSION);
  Platform::setDebug(true);

  Document *doc = Document::loadWithErrorReport(inputFile);
  if (!doc) {
    std::cerr << "Error: Could not reaf input file: " << inputFile << std::endl;
    return 1;
  }
  doc->runLatex(inputFile);
  ofstream out(outputFile);
  if (!out) {
    std::cerr << "Error: Could not open output file: " << outputFile
              << std::endl;
    delete doc;
    return 1;
  }
  render(out, doc, std::make_unique<Fonts>(doc->resources()));

  delete doc;
  return 0;
}
