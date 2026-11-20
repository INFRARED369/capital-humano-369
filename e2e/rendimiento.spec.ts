/**
 * NFR-RND-01 · LCP < 2.5 s en 4G (gate). Sin Lighthouse en local: Chromium + CDP con el perfil "Slow 4G" de
 * Lighthouse móvil (150 ms RTT, 1.6 Mbps de bajada, 750 kbps de subida) y CPU 4x más lenta; el LCP se lee con
 * PerformanceObserver (largest-contentful-paint, buffered). Caché fría en cada medición. Solo Chromium
 * (desktop y pixel-7): WebKit no expone CDP. En CI además corre `lighthouserc.json` sobre out/.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const LCP_MAX_MS = 2500;
const RUTAS = ['/', '/vacantes/agente-smart/'];

async function medirLcp(page: Page, ruta: string): Promise<{ lcp: number; elemento: string; bytes: number }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let bytes = 0;
  cdp.on('Network.loadingFinished', (e: { encodedDataLength: number }) => void (bytes += e.encodedDataLength));
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: { t: number; el: string } };
    w.__lcp = { t: 0, el: '' };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<PerformanceEntry & { element?: Element | null }>) {
        w.__lcp = { t: e.startTime, el: e.element ? `${e.element.tagName.toLowerCase()}${e.element.className ? `.${String(e.element.className).split(' ')[0]}` : ''}` : '?' };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.goto(ruta, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(1500); // margen para candidatos tardíos (fuentes, imágenes)
  // El LCP se congela con la primera interacción; se lee sin interactuar.
  const r = await page.evaluate(() => (window as unknown as { __lcp: { t: number; el: string } }).__lcp);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return { lcp: Math.round(r.t), elemento: r.el, bytes };
}

for (const ruta of RUTAS) {
  test(`LCP < 2.5 s con 4G lento + CPU 4x: ${ruta}`, async ({ page, browserName }, info) => {
    test.skip(browserName !== 'chromium', 'CDP solo en Chromium');
    test.setTimeout(90_000);
    const m = await medirLcp(page, ruta);
    info.annotations.push({ type: 'LCP', description: `${info.project.name} ${ruta}: ${m.lcp} ms (${m.elemento}), ${Math.round(m.bytes / 1024)} KiB transferidos` });
    console.log(`[LCP] ${info.project.name} ${ruta}: ${m.lcp} ms (${m.elemento}), ${Math.round(m.bytes / 1024)} KiB`);
    expect(m.lcp, `LCP de ${ruta} (${m.elemento})`).toBeGreaterThan(0);
    expect(m.lcp, `LCP de ${ruta} (${m.elemento})`).toBeLessThan(LCP_MAX_MS);
    // El video de 9.6 MB no debe descargarse completo durante la carga inicial.
    expect(m.bytes, 'bytes transferidos en la carga inicial').toBeLessThan(2 * 1024 * 1024);
  });
}
