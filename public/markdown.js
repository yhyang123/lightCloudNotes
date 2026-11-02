'use strict';

function renderMarkdown(source) {
  const html = marked.parse(source, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'input', 'button', 'textarea', 'form'],
    FORBID_ATTR: ['style', 'id', 'name', 'contenteditable'],
    ALLOW_DATA_ATTR: false,
  });
}
