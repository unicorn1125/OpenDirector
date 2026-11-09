/** Isolated API/Vite: hidden sources reserve default node numbers. */
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
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const headers = { "X-OpenDirector-Request": "1" };
  const health = await (
    await page.request.get(base + "/api/creation-test-health", { headers })
  ).json();
  assert.equal(health.isolated, true);
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
    const { creationClient, objectVersion } =
      await import("/src/backend/creationClient.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const nodes = Array.from({ length: 4 }, (_, index) =>
      createNode(
        "image",
        { x: index * 350, y: 100 },
        { title: `图片 ${index + 1}` },
      ),
    );
    const custom = createNode(
      "text",
      { x: 0, y: 500 },
      { title: "图片 6", text: "Custom name" },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("Node numbering " + crypto.randomUUID().slice(0, 8)),
      nodes: [...nodes, custom],
    });
    const client = creationClient(saved.id);
    const hidden = [nodes[0].id, nodes[3].id];
    for (const id of hidden) {
      const item = client.snapshot.canvasItems.find((item) => item.id === id);
      await client.command("canvas.hide", { itemId: id }, [
        objectVersion("canvas_item", item),
      ]);
    }
    client.close();
    await releaseBackendProject();
    return { id: saved.id, hidden, custom: custom.id };
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const add = page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加图片", exact: true });
  const savedTitle = async (title) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await page.request.get(
        `${base}/api/creation/projects/${fixture.id}`,
        { headers },
      );
      assert.ok(response.ok());
      const snapshot = await response.json();
      if (
        snapshot.canvasItems.some(
          (item) => item.title === title && item.kind === "image",
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Default title was not persisted: ${title}`);
  };
  await add.click();
  await savedTitle("图片 5");
  // Two requests in one browser callback must use sequential applied state.
  await add.evaluate((button) => {
    button.click();
    button.click();
  });
  await savedTitle("图片 8");
  const snapshot = await (
    await page.request.get(`${base}/api/creation/projects/${fixture.id}`, {
      headers,
    })
  ).json();
  assert.deepEqual(
    snapshot.canvasItems
      .filter((item) => item.kind === "image")
      .map((item) => item.title),
    ["图片 1", "图片 2", "图片 3", "图片 4", "图片 5", "图片 7", "图片 8"],
  );
  assert.ok(
    snapshot.canvasItems
      .filter((item) => fixture.hidden.includes(item.id))
      .every((item) => !item.visible),
  );
  assert.equal(
    snapshot.canvasItems.find((item) => item.id === fixture.custom).title,
    "图片 6",
  );
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.react-flow__node[data-id="' + fixture.hidden[1] + '"]')
      .count(),
    0,
  );
  await add.click();
  await savedTitle("图片 9");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      hiddenHighestNumber: true,
      rapidCreation: true,
      customTitleCollision: true,
      persistedAfterReload: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
