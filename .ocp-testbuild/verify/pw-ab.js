// A/B verification of the board-pagination patch, asserting on rendered DOM.
//
// Two byte-identical stremio-web builds differing ONLY in
// stremio_core_web_bg.wasm (stock v0.59.0 vs patched). A local stub addon
// serves a 200-item catalog 20 at a time and declares the `skip` extra.
//
// State lives in the core's web worker, so window.core.getState() is empty on
// the main thread -- we count rendered <MetaItem> tiles in the board row
// instead, which is what the user actually sees.
//
// Each row renders CATALOG_PREVIEW_SIZE placeholder divs padding out the tail,
// so "real" tiles are counted as anchors (<a class=meta-item...>), which only
// exist for actual items.
//
// Usage: node pw-ab.js

const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const BUILDS = {
    stock: path.join(ROOT, 'webstock', 'build'),
    patched: path.join(ROOT, 'webbuild', 'build'),
};
const ADDON_PORT = 8793;
const PAGE = 20;
const TOTAL = 200;
const ROW_TITLE = 'Paged List';

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png',
    '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
    '.map': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(rootDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let rel = decodeURIComponent(req.url.split('?')[0]);
            if (rel === '/') rel = '/index.html';
            const file = path.join(rootDir, path.normalize(rel));
            if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.statusCode = 404; res.end('not found'); return;
            }
            res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
            fs.createReadStream(file).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const manifest = {
    id: 'org.test.paging',
    version: '1.0.0',
    name: 'Paging Test',
    description: 'Stub addon for board pagination testing',
    resources: ['catalog'],
    types: ['movie'],
    idPrefixes: ['tt'],
    catalogs: [{
        id: 'paged', type: 'movie', name: ROW_TITLE,
        extra: [{ name: 'skip' }], extraSupported: ['skip'],
    }],
};

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64');

function startAddon(hits) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', '*');
            const url = req.url.split('?')[0];
            if (url === '/poster.png') {
                res.setHeader('Content-Type', 'image/png');
                return void res.end(PNG);
            }
            res.setHeader('Content-Type', 'application/json');
            if (url === '/manifest.json') return void res.end(JSON.stringify(manifest));
            const m = url.match(/^\/catalog\/movie\/paged(?:\/skip=(\d+))?\.json$/);
            if (m) {
                const skip = parseInt(m[1] || '0', 10);
                hits.push(skip);
                const metas = [];
                for (let i = skip; i < Math.min(skip + PAGE, TOTAL); i++) {
                    metas.push({
                        id: `tt${String(1000000 + i)}`,
                        type: 'movie',
                        name: `Item ${String(i).padStart(3, '0')}`,
                        poster: `http://127.0.0.1:${ADDON_PORT}/poster.png`,
                        posterShape: 'poster',
                    });
                }
                return void res.end(JSON.stringify({ metas }));
            }
            res.statusCode = 404;
            res.end('{}');
        });
        server.listen(ADDON_PORT, '127.0.0.1', () => resolve(server));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readRow = (page, rowTitle) => page.evaluate((title) => {
    const rows = Array.from(document.querySelectorAll('[class*="meta-row"]'));
    const row = rows.find((r) => {
        const t = r.querySelector('[class*="title"]');
        return t && t.textContent.trim().startsWith(title);
    });
    if (!row) {
        return {
            found: false,
            allRows: rows.map((r) => {
                const t = r.querySelector('[class*="title"]');
                return t ? t.textContent.trim().slice(0, 30) : '(untitled)';
            }),
        };
    }
    const anchors = Array.from(row.querySelectorAll('a[class*="meta-item"]'));
    const names = anchors
        .map((a) => (a.getAttribute('title') || a.textContent || '').trim())
        .filter(Boolean);
    return {
        found: true,
        realTiles: anchors.length,
        totalNodes: row.querySelectorAll('[class*="meta-item"]').length,
        first: names[0] || null,
        last: names[names.length - 1] || null,
    };
}, rowTitle);

async function runOne(browser, label, rootDir, addonUrl, hits) {
    hits.length = 0;
    const server = await serveStatic(rootDir);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    // Wait for the board to actually paint rows (core booted + catalogs loaded).
    await page.waitForFunction(
        () => document.querySelectorAll('[class*="meta-row"]').length > 0,
        { timeout: 90000 });
    await sleep(3000);

    // Install the paginating stub addon via the app's own core proxy.
    await page.evaluate(async (url) => {
        const manifest = await (await fetch(url)).json();
        window.core.dispatch({
            action: 'Ctx',
            args: { action: 'InstallAddon', args: { transportUrl: url, manifest, flags: {} } },
        });
    }, addonUrl);

    // Re-load the board so the new addon's catalog is included, then let the
    // row render.
    await sleep(2000);
    await page.evaluate(() => {
        window.core.dispatch({
            action: 'Load',
            args: { model: 'CatalogsWithExtra', args: { extra: [] } },
        }, 'board');
    });
    await page.waitForFunction((title) => {
        const rows = Array.from(document.querySelectorAll('[class*="meta-row"]'));
        return rows.some((r) => {
            const t = r.querySelector('[class*="title"]');
            return t && t.textContent.trim().startsWith(title);
        });
    }, ROW_TITLE, { timeout: 60000 }).catch(() => {});
    await sleep(4000);

    const initial = await readRow(page, ROW_TITLE);
    const hitsAfterInitial = hits.slice();

    // Ask the core for the next page of that specific catalog.
    const idx = await page.evaluate((title) => {
        const rows = Array.from(document.querySelectorAll('[class*="meta-row"]'));
        return rows.findIndex((r) => {
            const t = r.querySelector('[class*="title"]');
            return t && t.textContent.trim().startsWith(title);
        });
    }, ROW_TITLE);

    if (idx >= 0) {
        // The board model index and the DOM row index can differ (continue-watching
        // row is not a catalog), so try a small range around the DOM index.
        for (const cand of [idx, idx - 1, idx + 1, 0]) {
            if (cand < 0) continue;
            await page.evaluate((i) => {
                window.core.dispatch({
                    action: 'CatalogsWithExtra',
                    args: { action: 'LoadNextPage', args: i },
                }, 'board');
            }, cand);
            await sleep(2500);
            const probe = await readRow(page, ROW_TITLE);
            if (probe.found && probe.realTiles > (initial.realTiles || 0)) break;
        }
    }
    await sleep(2000);

    const afterNextPage = await readRow(page, ROW_TITLE);
    const shot = path.join(__dirname, `ab-${label}.png`);
    await page.screenshot({ path: shot });

    await ctx.close();
    server.close();
    return {
        label, initial, afterNextPage,
        addonSkipsRequested: hits.slice(),
        hitsAfterInitial,
        shot,
    };
}

(async () => {
    const hits = [];
    const addon = await startAddon(hits);
    const addonUrl = `http://127.0.0.1:${ADDON_PORT}/manifest.json`;
    const browser = await chromium.launch();

    const results = {};
    for (const [label, dir] of Object.entries(BUILDS)) {
        if (!fs.existsSync(dir)) throw new Error(`missing build dir: ${dir}`);
        results[label] = await runOne(browser, label, dir, addonUrl, hits);
    }

    await browser.close();
    addon.close();

    console.log(JSON.stringify(results, null, 2));
    const s = results.stock, p = results.patched;
    console.log('\n=== SUMMARY (real tiles rendered in "%s" row) ===', ROW_TITLE);
    console.log(`stock   : initial=${s.initial.realTiles} afterNextPage=${s.afterNextPage.realTiles} skips=${JSON.stringify(s.addonSkipsRequested)}`);
    console.log(`patched : initial=${p.initial.realTiles} afterNextPage=${p.afterNextPage.realTiles} skips=${JSON.stringify(p.addonSkipsRequested)}`);
})().catch((e) => {
    console.error('PW ERROR:', e && e.stack ? e.stack : e);
    process.exit(1);
});
