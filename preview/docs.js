// A doc's page on the site (scripts/build-docs.js): each ```mermaid block
// drawn as its diagram, as the Markdown view draws it. preview/build.js
// bundles it into dist/preview.

/* global document */

import { diagramDom } from '../web/diagrams.js';

for (const pre of document.querySelectorAll('pre.doc-diagram')) pre.replaceWith(diagramDom(pre.textContent));
