/** Isolated API only. Sample steady pointer interaction with 12 embedded images.
 * Run against Vite plus tests/browser/creation_server.py. CPU profiles go to /tmp;
 * reported times are diagnostic, not machine-dependent pass/fail thresholds.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5191";
const label = (process.env.PROFILE_LABEL ?? "current").replace(
  /[^a-z0-9_-]/gi,
  "",
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1700, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true);
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (r) =>
    r.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base);
  const fixture = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d");
    const pixels = ctx.createImageData(512, 512);
    let seed = 77;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const src = canvas.toDataURL("image/png");
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      ...createNode(
        "image",
        { x: 160 + (i % 4) * 240, y: 150 + Math.floor(i / 4) * 240 },
        {
          title: "Asset " + i,
          src,
          mediaRole: "asset",
          media: { width: 512, height: 512 },
        },
      ),
      width: 180,
      height: 180,
    }));
    const target = {
      ...createNode(
        "image",
        { x: 1180, y: 180 },
        { title: "Generator", prompt: "Reference test" },
      ),
      width: 210,
      height: 210,
    };
    nodes.push(target);
    const saved = await importWorkspaceDocument({
      ...createDocument(),
      title: "Drag profile " + crypto.randomUUID().slice(0, 8),
      nodes,
      edges: [
        { id: crypto.randomUUID(), source: nodes[0].id, target: target.id },
      ],
      viewport: { x: 0, y: 0, zoom: 0.85 },
    });
    await releaseBackendProject();
    return {
      id: saved.id,
      node: nodes[0].id,
      target: target.id,
      bytes: src.length,
    };
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.waitForTimeout(700);
  const card = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await card(fixture.target).click();
  await page
    .getByRole("textbox", { name: "生成提示词", exact: true })
    .waitFor();
  await page.waitForTimeout(700);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  const results = { fixture, scenarios: [], errors };
  for (const kind of ["pan", "node"]) {
    const close = page.getByRole("button", {
      name: "关闭生成面板",
      exact: true,
    });
    if (await close.isVisible()) {
      await close.focus();
      await page.keyboard.press("Enter");
    }
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(350);
    await card(fixture.target).click();
    await page
      .getByRole("textbox", { name: "生成提示词", exact: true })
      .waitFor();
    await page.waitForTimeout(300);
    let origin;
    if (kind === "node") {
      const box = await card(fixture.target).boundingBox();
      origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } else origin = { x: 1580, y: 780 };
    await page.evaluate(() => {
      window.__perfFrames = [];
      window.__perfLong = [];
      window.__perfLive = true;
      let last = performance.now();
      const tick = (now) => {
        if (!window.__perfLive) return;
        window.__perfFrames.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__perfObserver = new PerformanceObserver((list) =>
        window.__perfLong.push(...list.getEntries().map((x) => x.duration)),
      );
      window.__perfObserver.observe({ type: "longtask" });
    });
    const measured =
      kind === "node"
        ? card(fixture.target)
        : page.locator(".react-flow__viewport");
    const transformBefore = await measured.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    await cdp.send("Profiler.start");
    const started = Date.now();
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down({ button: kind === "pan" ? "middle" : "left" });
    await page.mouse.move(origin.x + 110, origin.y + 70, { steps: 45 });
    await page.mouse.up({ button: kind === "pan" ? "middle" : "left" });
    const elapsed = Date.now() - started;
    const { profile } = await cdp.send("Profiler.stop");
    const transformAfter = await measured.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    assert.notEqual(
      transformAfter,
      transformBefore,
      kind + " must actually move",
    );
    const frames = await page.evaluate(() => {
      window.__perfLive = false;
      window.__perfObserver.disconnect();
      return { frames: window.__perfFrames, long: window.__perfLong };
    });
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const times = new Map();
    profile.samples.forEach((id, i) => {
      const n = nodes.get(id);
      const key = n.callFrame.functionName + "|" + n.callFrame.url;
      times.set(
        key,
        (times.get(key) || 0) + (profile.timeDeltas?.[i] || 1000) / 1000,
      );
    });
    const top = [...times].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const sorted = frames.frames.sort((a, b) => a - b);
    results.scenarios.push({
      kind,
      elapsed,
      frameP95: sorted[Math.floor(sorted.length * 0.95)],
      frames: sorted.length,
      longTasks: frames.long.length,
      maxLong: Math.max(0, ...frames.long),
      top,
    });
    await fs.writeFile(
      `/tmp/opendirector-drag-${label}-${kind}.cpuprofile`,
      JSON.stringify(profile),
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
