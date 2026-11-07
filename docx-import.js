/*
 * docx-import.js — turns a .docx file into HTML for the editor's "Import
 * Word document" button. UMD like compose-core.js (browser global
 * WebhasteDocx / Node require), which is what lets the conversion be tested
 * headlessly. It does NOT touch the file system or the DOM: the caller
 * passes in the vendored mammoth library (vendor/mammoth/) and a
 * saveImage() callback that stores an embedded image in the project's
 * assets/ folder and returns the src to use.
 *
 * "Good enough, hand-editable afterward" (GitHub #5): mammoth maps Word's
 * semantic styles (headings, lists, tables, links, bold/italic) and
 * discards the visual ones (fonts, colours, sizes) by design. The caller
 * then runs the result through the paste sanitizer, so only whitelisted
 * tags survive regardless.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.WebhasteDocx = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Word styles that have a clean HTML equivalent but aren't in mammoth's
  // defaults (which already cover Heading 1-6, lists, bold, italic, strike).
  // Google Docs' .docx export names its title style "Title".
  const STYLE_MAP = [
    "p[style-name='Title'] => h1:fresh",
    "p[style-name='Quote'] => blockquote:fresh",
    "p[style-name='Intense Quote'] => blockquote:fresh",
  ];

  // Only formats every browser can display. Embedded EMF/WMF/TIFF (Word's
  // clip art and pasted charts) can't be shown in an <img>, so they're
  // skipped and counted rather than inserted as broken images.
  const IMAGE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };

  // arrayBuffer: the .docx bytes.
  // saveImage({ bytes: Uint8Array, extension, altText }) -> Promise<string|null>
  //   the src to use for that image, or null to leave it out (e.g. the
  //   author declined an oversized upload).
  // Resolves { html, imageCount, skippedImages, warningCount }.
  async function convertDocxToHtml(mammoth, arrayBuffer, saveImage) {
    let imageCount = 0;
    let skippedImages = 0;

    const convertImage = mammoth.images.imgElement(async (image) => {
      const extension = IMAGE_EXTENSIONS[image.contentType];
      if (!extension) {
        skippedImages++;
        return { src: "" };
      }
      const bytes = new Uint8Array(await image.read());
      const src = await saveImage({ bytes, extension, altText: image.altText || "" });
      if (!src) {
        skippedImages++;
        return { src: "" };
      }
      imageCount++;
      return { src };
    });

    const result = await mammoth.convertToHtml({ arrayBuffer }, { styleMap: STYLE_MAP, convertImage });

    // Skipped images came back as src="" — drop them rather than leave a
    // broken <img> in the page.
    const html = result.value
      .replace(/<img\b[^>]*\bsrc=""[^>]*>/gi, "")
      // ...which can leave an empty paragraph behind.
      .replace(/<p>\s*<\/p>/g, "")
      // Word always puts cell text in a paragraph; a lone one is just noise
      // inside a <td>/<th> (multi-paragraph cells keep theirs).
      .replace(/<(td|th)><p>((?:(?!<\/?p>)[\s\S])*)<\/p><\/\1>/g, "<$1>$2</$1>");
    return {
      html,
      imageCount,
      skippedImages,
      warningCount: result.messages.filter((m) => m.type === "warning").length,
    };
  }

  // "Q3 Report (final).docx" -> "q3-report-final": the base for image file
  // names, same character rules slugifyFileName() applies to page names.
  function imageBaseName(docxFileName) {
    const base = String(docxFileName || "")
      .replace(/\.docx$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "document";
  }

  return { convertDocxToHtml, imageBaseName, STYLE_MAP };
});
