/** Real project commands and files with an isolated, simulated image model. */
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
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1500, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true);
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base + "/");
  const fixture = await page.evaluate(async () => {
    const { request } = await import("/src/backend/api.ts");
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const { creationClient, objectVersion, currentAsset, itemSpec } =
      await import("/src/backend/creationClient.ts");
    const model = (await request("/model-configs")).find(
      (model) => model.kind === "image",
    );
    const source = createNode(
      "text",
      { x: 100, y: 150 },
      { title: "隐藏参考", text: "Reference v1", mediaRole: "asset" },
    );
    const visible = createNode(
      "text",
      { x: 100, y: 500 },
      { title: "可见参考", text: "Unchanged reference", mediaRole: "asset" },
    );
    const target = createNode(
      "image",
      { x: 600, y: 180 },
      {
        title: "参考展开验收",
        prompt: "Draw a landscape",
        settings: {
          mode: "image",
          model: model.modelId,
          modelConfigId: model.id,
          aspectRatio: "1:1",
          resolution: "1024",
          count: 1,
          prompt: "Draw a landscape",
        },
      },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("Hidden references"),
      nodes: [source, visible, target],
      edges: [source, visible].map((node) => ({
        id: crypto.randomUUID(),
        source: node.id,
        target: target.id,
      })),
      viewport: { x: 0, y: 0, zoom: 0.85 },
    });
    const client = creationClient(saved.id);
    const spec = itemSpec(client.snapshot, client.snapshot.canvasItems.find((item) => item.id === target.id));
    await client.command("generationSpec.setPrompt", {
      specId: spec.id,
      prompt: "Draw a landscape using ",
      promptContent: [
        { type: "text", text: "Draw a landscape using " },
        ...client.snapshot.references.filter((ref) => ref.targetSpecId === spec.id)
          .map((ref) => ({ type: "reference", referenceId: ref.id })),
      ],
    }, [objectVersion("generation_spec", spec)]);
    await client.submit(target.id);
    for (let n = 0; n < 100; n++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.refresh();
      if (client.snapshot.jobs[0]?.status === "succeeded") break;
    }
    if (client.snapshot.jobs[0]?.status !== "succeeded")
      throw new Error("Fixture generation failed");
    let item = client.snapshot.canvasItems.find(
      (item) => item.id === source.id,
    );
    await client.command("canvas.hide", { itemId: item.id }, [
      objectVersion("canvas_item", item),
    ]);
    const latest = await client.writeText(
      "new.md",
      "Reference v2 changed while hidden",
    );
    item = client.snapshot.canvasItems.find((item) => item.id === source.id);
    await client.command(
      "canvas.materialize",
      { itemId: item.id, asset: latest },
      [objectVersion("canvas_item", item)],
    );
    item = client.snapshot.canvasItems.find((item) => item.id === source.id);
    await client.command("canvas.update", { itemId: item.id, locked: true }, [
      objectVersion("canvas_item", item),
    ]);
    const result = {
      id: saved.id,
      source: source.id,
      visible: visible.id,
      target: target.id,
      before: client.snapshot,
      states: [...client.referenceStates],
      latest: latest.assetId,
      specId: itemSpec(
        client.snapshot,
        client.snapshot.canvasItems.find((item) => item.id === target.id),
      ).id,
      targetAsset: currentAsset(
        client.snapshot,
        client.snapshot.canvasItems.find((item) => item.id === target.id),
      ).id,
    };
    client.close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return result;
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const target = page.locator(`.react-flow__node[data-id="${fixture.target}"]`);
  const source = page.locator(`.react-flow__node[data-id="${fixture.source}"]`);
  assert.equal(await page.locator(".cw-node-reference-button").count(), 0);
  await target.locator(".cw-node").click();
  const editor = page.locator('.cw-composer [contenteditable="true"]');
  await editor.waitFor();
  const hiddenChip = editor
    .locator("[data-reference]")
    .filter({ hasText: "隐藏参考" });
  const visibleChip = editor
    .locator("[data-reference]")
    .filter({ hasText: "可见参考" });
  await visibleChip.waitFor();
  assert.equal(await hiddenChip.count(), 0);
  assert.equal(await page.locator('.cw-reference-thumbnail [title*="隐藏参考"]').count(), 0);
  assert.ok(fixture.before.jobs[0].inputSnapshot.references.some(
    (ref) => ref.sourceVersion?.id === fixture.source,
  ));
  assert.equal(
    await visibleChip.evaluate((el) => getComputedStyle(el).borderStyle),
    "solid",
  );
  // Restoring a legacy source reveals its saved relationship again.
  await page.evaluate(async ({ id, source }) => {
    const { creationClient, objectVersion } =
      await import("/src/backend/creationClient.ts");
    const client = creationClient(id);
    const item = client.snapshot.canvasItems.find((item) => item.id === source);
    await client.command("canvas.show", { item }, [
      objectVersion("canvas_item", item),
    ]);
  }, fixture);
  await source.waitFor();
  await page.waitForFunction(() => {
    const chip = [
      ...document.querySelectorAll(".cw-composer [data-reference]"),
    ].find((el) => el.textContent.includes("隐藏参考"));
    return chip && !chip.classList.contains("is-off-canvas");
  });
  assert.equal(
    await hiddenChip.evaluate((el) => getComputedStyle(el).borderStyle),
    "solid",
  );
  const after = await page.evaluate(async (id) => {
    const client = (
      await import("/src/backend/creationClient.ts")
    ).creationClient(id);
    await client.refresh();
    return client.snapshot;
  }, fixture.id);
  for (const key of ["references", "generationSpecs", "jobs", "results"])
    assert.deepEqual(after[key], fixture.before[key], key);
  const visibleSource = page.locator(
    `.react-flow__node[data-id="${fixture.visible}"]`,
  );
  await visibleSource.locator(".cw-text-display").click();
  await page.keyboard.press("Delete");
  await visibleSource.waitFor({ state: "detached" });
  const projectPath = `/api/creation/projects/${fixture.id}`;
  await page.waitForFunction(async ({ path, id }) => {
    const response = await fetch(path, { headers: { "X-OpenDirector-Request": "1" } });
    const project = await response.json();
    return project.canvasItems.some((item) => item.id === id && !item.visible) &&
      project.references.some((ref) => ref.source.id === id && !ref.active);
  }, { path: projectPath, id: fixture.visible }, { polling: 250 });
  await target.locator(".cw-node").click();
  await hiddenChip.waitFor();
  assert.equal(await visibleChip.count(), 0);
  assert.equal(await page.locator('.cw-reference-thumbnail [title*="可见参考"]').count(), 0);
  const latest = await (await page.request.get(base + projectPath, {
    headers: { "X-OpenDirector-Request": "1" },
  })).json();
  assert.deepEqual(latest.jobs, fixture.before.jobs);
  assert.equal(await page.locator(".cw-node-reference-button").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS hidden reference excluded from current composer, historical inputs retained",
  );
} finally {
  await page
    .evaluate(async () =>
      (await import("/src/backend/projects.ts")).releaseBackendProject(),
    )
    .catch(() => {});
  await browser.close();
}
