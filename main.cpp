#include "ipecairopainter.h"
#include "ipethumbs.h"
#include "ipereference.h"
#include "ipegroup.h"

#include <cairo.h>
#include <cairo-svg.h>

#include <fstream>
#include <iostream>
#include <sstream>

using namespace std;
using namespace ipe;

static cairo_status_t stream_writer(void *closure,
                                    const unsigned char *data,
                                    unsigned int length) {
  ostream * os = static_cast<ostream *>(closure);
  os->write(reinterpret_cast<const char *>(data), length);
    return  os->good()? CAIRO_STATUS_SUCCESS: CAIRO_STATUS_WRITE_ERROR;
}

// class DecorationPainter : public Painter {
//     public:
//         DecorationPainter(Painter &painter, const Vector &center, double dx, double dy);
//
//     protected:
//         virtual void doPush();
//         virtual void doPop();
//         virtual void doNewPath();
//         virtual void doMoveTo(const Vector &v);
//         virtual void doLineTo(const Vector &v);
//         virtual void doCurveTo(const Vector &v1, const Vector &v2, const Vector &v3);
//         virtual void doClosePath();
//         virtual void doDrawPath(TPathMode mode);
//         Vector adapt(const Vector &v);
//
//     private:
//         Painter &iPainter;
//         Vector iCenter;
//         double iX, iY;
// };

void render(
    ostream &out,
    Document *iDoc,
    std::unique_ptr<Fonts> iFonts,
    double tolerance = 0.1,
    double zoom = 1.0
) {
    const Layout *iLayout = iDoc->cascade()->findLayout();
    Vector offset = iLayout->paper().topLeft();
    int wid = static_cast<int>(iLayout->paper().width() * zoom);
    int ht = static_cast<int>(iLayout->paper().height() * zoom);

    std::stringstream cache;
    cairo_surface_t *surface = cairo_svg_surface_create_for_stream(&stream_writer, &cache, wid, ht);
    cairo_t *cc = cairo_create(surface);
    cairo_scale(cc, zoom, -zoom);
    cairo_translate(cc, -offset.x, -offset.y);

    cairo_set_tolerance(cc, tolerance);
    CairoPainter painter(iDoc->cascade(), iFonts.get(), cc, zoom, true, true);

    auto flush_object = [&](const vector<string> &classes) {
        cairo_surface_flush(surface);
        cairo_show_page(cc);
        string s = cache.str();
        cache.str("");
        cache.clear();

        if (s.empty())
            return;

        // cache should start with an SVG/XML tag something like "<name ..."
        // we want to first print this, then insert a class definition, then the remainder of cache to out
        size_t tag_start = s.find('<');
        while (tag_start != string::npos && (s[tag_start + 1] == '?' || s[tag_start + 1] == '!'))
            tag_start = s.find('<', tag_start + 1);

        if (tag_start != string::npos) {
            size_t tag_end = s.find_first_of(" \n\r\t/>", tag_start + 1);
            if (tag_end != string::npos) {
                out << s.substr(0, tag_end) << " class=\"";
                for (size_t i = 0; i < classes.size(); ++i)
                    out << (i == 0 ? "" : " ") << classes[i];
                out << "\"" << s.substr(tag_end);
            } else {
                out << s;
            }
        } else {
            out << s;
        }
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
            Attribute bg = page->backgroundSymbol(iDoc->cascade());
            const Symbol *background = iDoc->cascade()->findSymbol(bg);
            if (background && page->findLayer("BACKGROUND") < 0) {
                painter.drawSymbol(bg);
                flush_object({"background", pagename});
            }

            const Text *title = page->titleText();
            if (title) {
                title->draw(painter);
                flush_object({"title", pagename});
            }
        }

        for (int j = 0; j < page->count(); ++j) {
            // if (page->objectVisible(view, i)) {
            int layer = page->layerOf(j);
            Object *obj = page->object(j);

            // // we're not tagging objects within groups, so this is currently deactivated
            // if (obj->type() == Object::EGroup) {
            //     Group *grp = obj->asGroup();
            //     Attribute deco = grp->getAttribute(EPropDecoration);
            //     if (!deco.isNormal()) {
            //         painter.pushMatrix();
            //         auto m = painter.matrix();
            //         painter.untransform(ETransformationsTranslations);
            //         Rect r;
            //         grp->addToBBox(r, m, false);
            //         double dx = 0.5 * (r.width() - 200.0);
            //         double dy = 0.5 * (r.height() - 100.0);
            //         DecorationPainter dp(painter, r.center(), dx, dy);
            //         dp.translate(r.center() - Vector(200.0, 150.0));
            //         dp.drawSymbol(deco);
            //         painter.popMatrix();
            //     }
            //     painter.pushMatrix();
            //     painter.transform(grp->matrix());
            //     painter.untransform(grp->transformations());
            //     Shape clip = grp->clip();
            //     if (clip.countSubPaths()) {
            //         painter.push();
            //         painter.newPath();
            //         clip.draw(painter);
            //         painter.addClipPath();
            //     }
            //     for (auto it = grp->begin(); it != grp->end(); ++it) { (*it)->draw(painter); }
            //     if (clip.countSubPaths()) {
            //         painter.pop();
            //     }
            //     painter.popMatrix();
            //     continue;
            // }

            painter.pushMatrix();
            // painter.transform(layerMatrices[layer]);
            obj->draw(painter);
            painter.popMatrix();

            vector tags{
                "objnr-" + to_string(j), "layernr-" + to_string(layer), "layer-" + page->layer(layer).s(), pagename
            };
            if (obj->getCustom().isString() && !obj->getCustom().string().empty()) {
                tags.push_back("custom-" + obj->getCustom().string().s());
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
                        tags.push_back("text-style-" + style.string().s());
                    } else if (style.isSymbolic()) {
                        tags.push_back("text-style-" + Repository::get()->toString(style.index()).s());
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
                        tags.push_back("ref-" + name.string().s());
                    } else if (name.isSymbolic()) {
                        tags.push_back("ref-" + Repository::get()->toString(name.index()).s());
                    }
                    break;
                }
            }
            flush_object(tags);
        }
        painter.popMatrix();
    }

    // cairo_surface_flush(surface);
    // cairo_show_page(cc);

    cairo_destroy(cc);
    cairo_surface_destroy(surface);
}

int main(int argc, char **argv) {
    Platform::initLib(IPELIB_VERSION);
    Platform::setDebug(true);

    Document *doc = Document::loadWithErrorReport(
        "/home/finksim/work/publications/partial-level-planarity/presentation.ipe");
    if (!doc) return 1;
    doc->runLatex("presentation.ipe");
    ofstream out("test.svg");
    render(out, doc, std::make_unique<Fonts>(doc->resources()));

    return 0;
}
