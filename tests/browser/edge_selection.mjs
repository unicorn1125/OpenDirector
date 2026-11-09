/** Isolated real-project verification: edge selection, dwell deletion and undo. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1800, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).json()
    ).isolated,
    true,
  );
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base);
  const fixture = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    canvas.getContext("2d").fillRect(0, 0, 160, 100);
    const sources = [0, 1, 2].map((i) => {
      const node = createNode(
        "image",
        { x: 220, y: 180 + i * 220 },
        {
          title: `连线选择素材 ${i + 1}`,
          src: canvas.toDataURL(),
          mediaRole: "asset",
          assetState: "ready",
          mimeType: "image/png",
          media: { width: 160, height: 100 },
        },
      );
      node.width = 220;
      node.height = 140;
      return node;
    });
    const target = createNode(
      "video",
      { x: 1100, y: 400 },
      {
        title: "连线选择目标",
        settings: { videoMode: "reference" },
      },
    );
    target.width = 240;
    target.height = 180;
    const edges = sources.map((node) => ({
      id: crypto.randomUUID(),
      source: node.id,
      target: target.id,
      sourceHandle: "out",
      targetHandle: "in",
    }));
    const saved = await importWorkspaceDocument({
      ...createDocument("Edge selection fixture"),
      nodes: [...sources, target],
      edges,
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return {
      id: saved.id,
      sources: sources.map((node) => node.id),
      edges: edges.map((edge) => edge.id),
    };
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const edge = (id) => page.locator(`.react-flow__edge[data-id="${id}"]`);
  const expectSelection = async (ids) => {
    await page.waitForFunction(
      (expected) => {
        const actual = [
          ...document.querySelectorAll(".react-flow__edge.selected"),
        ]
          .map((el) => el.dataset.id)
          .sort();
        return JSON.stringify(actual) === JSON.stringify(expected);
      },
      [...ids].sort(),
    );
  };
  const point = (id, fraction = 0.5) =>
    edge(id)
      .locator(".react-flow__edge-path")
      .evaluate((path, fraction) => {
        const local = path.getPointAtLength(path.getTotalLength() * fraction);
        const screen = local.matrixTransform(path.getScreenCTM());
        return { x: screen.x, y: screen.y };
      }, fraction);
  const clickEdge = async (id) => {
    const p = await point(id);
    await page.mouse.click(p.x, p.y);
  };
  const del = page.getByRole("button", { name: "删除此连线", exact: true });
  const [a, b, c] = fixture.edges;
  await clickEdge(a);
  await expectSelection([a]);
  await page.keyboard.down("Control");
  try {
    await clickEdge(b);
    await expectSelection([a, b]);
    await clickEdge(a);
    await expectSelection([b]);
    await clickEdge(c);
    await expectSelection([b, c]);
  } finally {
    await page.keyboard.up("Control");
  }
  await clickEdge(a);
  await expectSelection([a]);
  await page.mouse.click(800, 950);
  await expectSelection([]);

  const points = await Promise.all(fixture.edges.map((id) => point(id)));
  const rect = {
    x: Math.min(...points.map((p) => p.x)) - 60,
    y: Math.min(...points.map((p) => p.y)) - 60,
    right: Math.max(...points.map((p) => p.x)) + 60,
    bottom: Math.max(...points.map((p) => p.y)) + 60,
  };
  const marquee = async (reverse = false) => {
    const start = reverse ? { x: rect.right, y: rect.bottom } : rect;
    const end = reverse ? rect : { x: rect.right, y: rect.bottom };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await expectSelection(fixture.edges);
    await page.mouse.up();
    await expectSelection(fixture.edges);
    assert.equal(
      await page.locator(".react-flow__node.selected").count(),
      0,
      "only curves cross the marquee",
    );
  };
  await marquee();
  await page.mouse.click(800, 950);
  await expectSelection([]);
  await marquee(true);

  const p = await point(b);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(250);
  assert.equal(await del.count(), 0, "no delete control before 0.5 seconds");
  await page.mouse.move(p.x, p.y + 60);
  await page.waitForTimeout(400);
  assert.equal(await del.count(), 0, "leaving cancels the dwell timer");
  await page.mouse.move(p.x, p.y);
  await del.waitFor();
  await page.screenshot({ path: ".opendirector/edge-selection-dark.png" });
  await page.mouse.move(p.x, p.y + 60);
  await del.waitFor({ state: "detached" });

  for (const percent of [60, 150, 100]) {
    await page.getByRole("button", { name: "缩放选项", exact: true }).click();
    await page
      .getByRole("spinbutton", { name: "缩放百分比" })
      .fill(String(percent));
    await page.getByRole("button", { name: "缩放选项", exact: true }).click();
    const current = await point(b);
    await page.mouse.move(current.x, current.y);
    await del.waitFor();
    const bounds = await del.boundingBox();
    // The control is 18 CSS pixels at every zoom (foreignObject is 18 / zoom).
    assert.ok(
      Math.abs(bounds.width - 18) < 0.6 && Math.abs(bounds.height - 18) < 0.6,
      JSON.stringify(bounds),
    );
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({ path: ".opendirector/edge-selection-light.png" });
  await del.click();
  await expectSelection([a, c]);
  await edge(b).waitFor({ state: "detached" });
  const state = () =>
    page.evaluate(
      async (id) =>
        (await import("/src/backend/creationClient.ts")).creationClient(id)
          .snapshot,
      fixture.id,
    );
  const waitReferences = async (count) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const snapshot = await state();
      const active = snapshot.references.filter(
        (reference) => reference.active,
      );
      if (active.length === count) return active;
      await page.waitForTimeout(80);
    }
    throw new Error(`Expected ${count} persisted references`);
  };
  const remaining = await waitReferences(2);
  assert.deepEqual(
    remaining.map((r) => r.source.id).sort(),
    [fixture.sources[0], fixture.sources[2]].sort(),
  );
  await page.keyboard.press("Control+z");
  await waitReferences(3);
  await edge(b).waitFor();
  // Unselected lines never expose a destructive control.
  await page.mouse.click(800, 950);
  const unselected = await point(b);
  await page.mouse.move(unselected.x, unselected.y);
  await page.waitForTimeout(650);
  assert.equal(await del.count(), 0);
  // Delete and re-open verifies persistence, including the other two references.
  await clickEdge(b);
  await del.waitFor();
  await del.click();
  await waitReferences(2);
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(await page.locator(".react-flow__edge").count(), 2);
  assert.deepEqual(
    (await state()).references
      .filter((r) => r.active)
      .map((r) => r.source.id)
      .sort(),
    [fixture.sources[0], fixture.sources[2]].sort(),
  );
  assert.deepEqual(errors, []);
  console.log(
    "edge selection: Ctrl toggles, bidirectional marquee, hover delay/cancellation, fixed-size controls, one-edge deletion, undo and persistence passed",
  );
} catch (error) {
  await page.screenshot({ path: ".opendirector/edge-selection-failure.png" });
  console.error({
    errors,
    selected: await page.locator(".react-flow__edge.selected").count(),
  });
  throw error;
} finally {
  await browser.close();
}
