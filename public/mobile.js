(() => {
  'use strict';

  const viewport = window.visualViewport;
  if (!viewport) return;
  const stylesheetUrl = new URL('/styles.css', window.location.href).href;
  const stylesheet = Array.from(document.styleSheets).find(sheet => sheet.href === stylesheetUrl);
  if (!stylesheet) return;
  let rule;
  try {
    const index = stylesheet.insertRule(':root { --visual-height: 100dvh; --visual-offset: 0px; }', stylesheet.cssRules.length);
    rule = stylesheet.cssRules[index];
  } catch { return; }
  let frame = 0;
  function update() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      rule.style.setProperty('--visual-height', `${Math.round(viewport.height)}px`);
      rule.style.setProperty('--visual-offset', `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    });
  }
  // Update the same-origin stylesheet, not inline styles, to preserve the CSP.
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('pageshow', update);
  update();
})();
