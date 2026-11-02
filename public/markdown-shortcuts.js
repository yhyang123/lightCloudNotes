'use strict';

function installMarkdownShortcuts(editor, enabled, changed) {
  let converting = false;
  let composing = false;
  editor.addEventListener('compositionstart', () => { composing = true; });
  editor.addEventListener('compositionend', () => { composing = false; });

  function context() {
    if (!enabled() || composing || converting) return null;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const element = node.nodeType === 3 ? node.parentElement : node;
    if (!editor.contains(element) || element.closest('pre,code,table,a,[contenteditable="false"]')) return null;
    return { selection, range, node, element };
  }

  function insert(range, html, original, caretSelector) {
    converting = true;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let success = false;
    try {
      success = document.execCommand('insertHTML', false, html);
      if (success) {
        if (caretSelector) {
          const current = selection.anchorNode;
          const parent = current?.nodeType === 3 ? current.parentElement : current;
          let target = parent?.closest?.(caretSelector);
          if (!target) target = editor.querySelector(caretSelector + '[data-md-caret]');
          if (target) {
            const caret = document.createRange();
            caret.selectNodeContents(target);
            caret.collapse(true);
            selection.removeAllRanges();
            selection.addRange(caret);
          }
          editor.querySelectorAll('[data-md-caret]').forEach(el => el.removeAttribute('data-md-caret'));
        }
        changed();
      } else {
        selection.removeAllRanges();
        selection.addRange(original);
      }
    } finally {
      converting = false;
    }
    return success;
  }

  editor.addEventListener('beforeinput', (event) => {
    if (event.isComposing || !event.cancelable || event.defaultPrevented) return;
    const space = event.inputType === 'insertText' && event.data === ' ';
    const enter = event.inputType === 'insertParagraph';
    if (!space && !enter) return;
    const ctx = context();
    if (!ctx) return;
    const block = ctx.element.closest('p,div');
    if (!block || block === editor || block.parentElement !== editor) return;
    if (Array.from(block.childNodes).some(node => node.nodeType !== 3 && node.nodeName !== 'BR')) return;
    const prefixRange = ctx.range.cloneRange();
    prefixRange.selectNodeContents(block);
    prefixRange.setEnd(ctx.range.startContainer, ctx.range.startOffset);
    const prefix = prefixRange.toString().replace(/\u00a0/g, ' ');
    if (prefix !== block.textContent.replace(/\u00a0/g, ' ')) return;
    let html = '';
    let selector = '';
    if (space) {
      if (/^#{1,3}$/.test(prefix)) {
        selector = 'h' + prefix.length;
        html = `<${selector} data-md-caret><br></${selector}>`;
      } else if (prefix === '>') {
        selector = 'blockquote';
        html = '<blockquote data-md-caret><br></blockquote>';
      } else if (/^[-*+]$/.test(prefix) || prefix === '1.') {
        const tag = prefix === '1.' ? 'ol' : 'ul';
        selector = 'li';
        html = `<${tag}><li data-md-caret><br></li></${tag}>`;
      }
    } else {
      const fence = /^```([a-zA-Z0-9_+-]{0,30})$/.exec(prefix);
      if (fence) {
        selector = 'pre';
        html = `<pre data-md-caret data-lang="${fence[1]}"><br></pre><p><br></p>`;
      } else if (/^(---|\*\*\*)$/.test(prefix)) {
        selector = 'p';
        html = '<hr><p data-md-caret><br></p>';
      }
    }
    if (!html) return;
    const replacement = document.createRange();
    replacement.selectNode(block);
    if (insert(replacement, html, ctx.range.cloneRange(), selector)) event.preventDefault();
  });

  editor.addEventListener('input', (event) => {
    if (event.isComposing || event.inputType !== 'insertText' || !['*', '~', '`'].includes(event.data)) return;
    const ctx = context();
    if (!ctx || ctx.node.nodeType !== 3 || ctx.element.closest('strong,b,em,i,s,strike')) return;
    const text = ctx.node.textContent.slice(0, ctx.range.startOffset);
    const patterns = [
      { re: /(?:^|\s)(\*\*([^*\n]+)\*\*)$/, tag: 'strong' },
      { re: /(?:^|\s)(~~([^~\n]+)~~)$/, tag: 's' },
      { re: /(?:^|\s)(`([^`\n]+)`)$/, tag: 'code' },
      { re: /(?:^|\s)(\*([^*\n]+)\*)$/, tag: 'em' },
    ];
    for (const pattern of patterns) {
      const match = pattern.re.exec(text);
      if (!match) continue;
      const replacement = ctx.range.cloneRange();
      replacement.setStart(ctx.node, ctx.range.startOffset - match[1].length);
      const safe = match[2].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      insert(replacement, `<${pattern.tag}>${safe}</${pattern.tag}>`, ctx.range.cloneRange());
      return;
    }
  });
}
