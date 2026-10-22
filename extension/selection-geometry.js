// Shared by the content script and unit tests. Keep selection UI anchored to
// visible text fragments; whole-editor selections can have enormous bounds.
(function (root) {
  function isUsableRect(rect, viewportWidth, viewportHeight) {
    if (!rect) return false;
    const values = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height];
    if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  }

  function getSelectionAnchorRect(range, fallbackRect, viewportWidth, viewportHeight) {
    try {
      const fragments = Array.from(range?.getClientRects?.() || []);
      const visibleFragments = fragments.filter((rect) =>
        isUsableRect(rect, viewportWidth, viewportHeight) &&
        rect.height <= Math.max(64, viewportHeight * 0.25)
      );
      if (visibleFragments.length) return visibleFragments[visibleFragments.length - 1];

      // Some rich editors return only a large block rectangle. A collapsed
      // copy of the range often still exposes the selected text's endpoint.
      const endpoint = range?.cloneRange?.();
      if (endpoint) {
        endpoint.collapse(false);
        const caret = endpoint.getBoundingClientRect();
        if (caret && Number.isFinite(caret.left) && Number.isFinite(caret.top) &&
            Number.isFinite(caret.height) && caret.height > 0 &&
            caret.left >= 0 && caret.left < viewportWidth && caret.top >= 0 && caret.top < viewportHeight) {
          return { left: caret.left, top: caret.top, right: caret.left + 1,
            bottom: caret.top + caret.height, width: 1, height: caret.height };
        }
      }

      const bounds = range?.getBoundingClientRect?.();
      const isTooLarge = bounds && (bounds.width > viewportWidth * 0.8 || bounds.height > viewportHeight * 0.6);
      if (!isTooLarge && isUsableRect(bounds, viewportWidth, viewportHeight)) return bounds;
    } catch (error) {
      // Detached or cross-root selection ranges fall back to the editor bounds.
    }
    return fallbackRect;
  }

  // Native input and textarea selections do not expose Range rectangles. Map
  // a style-matched mirror's text fragments back into the field's scroll viewport.
  function projectTextFieldRects(fragments, fieldRect, mirrorRect, metrics, viewportWidth, viewportHeight, ancestorClip = null) {
    const scaleX = fieldRect.width / metrics.offsetWidth;
    const scaleY = fieldRect.height / metrics.offsetHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
    const clipLeft = Math.max(0, ancestorClip?.left ?? 0, fieldRect.left + metrics.clientLeft * scaleX);
    const clipTop = Math.max(0, ancestorClip?.top ?? 0, fieldRect.top + metrics.clientTop * scaleY);
    const clipRight = Math.min(viewportWidth, ancestorClip?.right ?? viewportWidth,
      fieldRect.left + (metrics.clientLeft + metrics.clientWidth) * scaleX);
    const clipBottom = Math.min(viewportHeight, ancestorClip?.bottom ?? viewportHeight,
      fieldRect.top + (metrics.clientTop + metrics.clientHeight) * scaleY);
    if (clipRight <= clipLeft || clipBottom <= clipTop) return null;

    let anchor = null;
    for (const fragment of fragments) {
      const left = fieldRect.left + (fragment.left - mirrorRect.left - metrics.scrollLeft) * scaleX;
      const top = fieldRect.top + (fragment.top - mirrorRect.top - metrics.scrollTop) * scaleY;
      const right = fieldRect.left + (fragment.right - mirrorRect.left - metrics.scrollLeft) * scaleX;
      const bottom = fieldRect.top + (fragment.bottom - mirrorRect.top - metrics.scrollTop) * scaleY;
      const clippedLeft = Math.max(left, clipLeft);
      const clippedTop = Math.max(top, clipTop);
      const clippedRight = Math.min(right, clipRight);
      const clippedBottom = Math.min(bottom, clipBottom);
      if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) continue;
      anchor = {
        left: clippedLeft, top: clippedTop, right: clippedRight, bottom: clippedBottom,
        width: clippedRight - clippedLeft, height: clippedBottom - clippedTop,
      };
    }
    return anchor;
  }

  function getAncestorClip(field, viewportWidth, viewportHeight) {
    const clip = { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight };
    const view = field.ownerDocument.defaultView;
    let parent = field.parentElement || field.getRootNode?.().host;
    while (parent?.nodeType === 1) {
      const style = view.getComputedStyle(parent);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (clipsX || clipsY) {
        const rect = parent.getBoundingClientRect();
        const scaleX = rect.width / parent.offsetWidth;
        const scaleY = rect.height / parent.offsetHeight;
        if (clipsX && Number.isFinite(scaleX)) {
          clip.left = Math.max(clip.left, rect.left + parent.clientLeft * scaleX);
          clip.right = Math.min(clip.right, rect.left + (parent.clientLeft + parent.clientWidth) * scaleX);
        }
        if (clipsY && Number.isFinite(scaleY)) {
          clip.top = Math.max(clip.top, rect.top + parent.clientTop * scaleY);
          clip.bottom = Math.min(clip.bottom, rect.top + (parent.clientTop + parent.clientHeight) * scaleY);
        }
      }
      parent = parent.parentElement || parent.getRootNode?.().host;
    }
    return clip;
  }

  function getTextFieldSelectionRect(field, start, end, viewportWidth, viewportHeight) {
    if (!field || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
        end > field.value?.length || !field.clientWidth || !field.clientHeight) return null;
    const fieldRect = field.getBoundingClientRect();
    if (!isUsableRect(fieldRect, viewportWidth, viewportHeight)) return null;
    const doc = field.ownerDocument;
    const style = doc.defaultView.getComputedStyle(field);
    const mirror = doc.createElement("div");
    const styleProps = [
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize",
      "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontKerning", "fontFeatureSettings",
      "fontVariationSettings", "fontSizeAdjust", "lineHeight", "letterSpacing",
      "wordSpacing", "textAlign", "textTransform", "textIndent", "direction", "tabSize",
      "wordBreak", "overflowWrap", "writingMode", "textOrientation", "textRendering", "hyphens",
    ];
    mirror.style.all = "initial";
    mirror.style.display = "block";
    mirror.style.position = "fixed";
    mirror.style.left = "-100000px";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.boxSizing = "border-box";
    mirror.style.overflow = "visible";
    mirror.style.height = "auto";
    mirror.style.borderStyle = "solid";
    mirror.style.borderColor = "transparent";
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      mirror.style[`border${side}Width`] = style[`border${side}Width`];
    }
    for (const prop of styleProps) mirror.style[prop] = style[prop];
    // clientWidth excludes the native scrollbar. The mirror has no scrollbar,
    // so this recreates the textarea's actual line-wrapping width.
    const borderWidth = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    mirror.style.width = `${field.clientWidth + borderWidth}px`;
    mirror.style.whiteSpace = field.tagName === "TEXTAREA" && field.wrap !== "off" ? "pre-wrap" : "pre";
    if (field.tagName === "TEXTAREA" && field.wrap !== "off") mirror.style.overflowWrap = "break-word";
    // Keep the value in one text node. Splitting a word at the selection edge
    // with a span can create a different wrap opportunity than the textarea.
    const text = doc.createTextNode(field.value);
    mirror.appendChild(text);
    try {
      doc.body.appendChild(mirror);
      const range = doc.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      return projectTextFieldRects(
        range.getClientRects(), fieldRect, mirror.getBoundingClientRect(),
        {
          offsetWidth: field.offsetWidth, offsetHeight: field.offsetHeight,
          clientWidth: field.clientWidth, clientHeight: field.clientHeight,
          clientLeft: field.clientLeft, clientTop: field.clientTop,
          scrollLeft: field.scrollLeft, scrollTop: field.scrollTop,
        }, viewportWidth, viewportHeight, getAncestorClip(field, viewportWidth, viewportHeight)
      );
    } catch (error) {
      return null;
    } finally {
      mirror.remove();
    }
  }

  function resolveSelectionStart(source, selectedText, offset) {
    if (Number.isInteger(offset) && offset >= 0 && source.slice(offset, offset + selectedText.length) === selectedText) {
      return offset;
    }
    if (selectedText === source) return 0;
    const match = source.indexOf(selectedText);
    if (match < 0 || source.indexOf(selectedText, match + 1) !== -1) return -1;
    return match;
  }

  function getNearPosition(anchorRect, width, height, viewportWidth, viewportHeight, options = {}) {
    const gap = Number.isFinite(options.gap) ? options.gap : 6;
    const inset = 8;
    const preferBelow = options.preferBelow !== false;
    const spaceBelow = viewportHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const fitsBelow = spaceBelow >= height + gap + inset;
    const fitsAbove = spaceAbove >= height + gap + inset;
    let top;
    let side;

    if ((preferBelow && fitsBelow) || (!preferBelow && !fitsAbove && fitsBelow)) {
      top = anchorRect.bottom + gap;
      side = "below";
    } else if (fitsAbove) {
      top = anchorRect.top - height - gap;
      side = "above";
    } else {
      top = Math.max(inset, Math.min(anchorRect.bottom + gap, viewportHeight - height - inset));
      side = "below";
    }

    const requestedLeft = options.align === "right" ? anchorRect.right - width : anchorRect.left;
    const maxLeft = Math.max(inset, viewportWidth - width - inset);
    const left = Math.max(inset, Math.min(requestedLeft, maxLeft));
    const maxTop = Math.max(inset, viewportHeight - height - inset);
    return { left, top: Math.max(inset, Math.min(top, maxTop)), side };
  }

  const api = Object.freeze({
    isUsableRect, getSelectionAnchorRect, getTextFieldSelectionRect, projectTextFieldRects,
    resolveSelectionStart, getNearPosition,
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GembarSelectionGeometry = api;
})(globalThis);
