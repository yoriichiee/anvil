// Regression test for the L- (phone width) check: with isMobile emulation Chrome widens the layout viewport to fit
// wide content, so innerWidth == scrollWidth and a comparison against innerWidth always "passes". measureWidth()
// compares against the emulated screen width instead. Needs Chrome or Edge; skipped when none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserPath, launch, measureWidth, DEVICES } from '../src/lib.mjs';

const page = body => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${body}</body></html>`;

test('phone width: a too-wide page is caught, a fitting page passes', { skip: !browserPath() && 'no Chrome or Edge installed' }, async () => {
  const browser = await launch();
  try {
    const d = DEVICES.phone;
    const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.deviceScaleFactor, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.setContent(page('<div class="wide-table" style="width:850px;height:40px;background:#ccc">wide</div>'));
    const wide = await measureWidth(p);
    assert.equal(wide.iw, 390);
    assert.ok(wide.sw > wide.iw + 1, `expected a sideways scroll, got ${JSON.stringify(wide)}`);
    assert.ok(wide.outer.some(s => s.includes('wide-table')));
    await p.setContent(page('<p style="padding:16px">fits</p>'));
    const ok = await measureWidth(p);
    assert.ok(ok.sw <= ok.iw + 1, `expected no sideways scroll, got ${JSON.stringify(ok)}`);
    await ctx.close();
  } finally { await browser.close(); }
});
