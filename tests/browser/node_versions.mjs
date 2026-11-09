/** Isolated fixture + real files; no real model service. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    const { creationClient, objectVersion, currentAsset } =
      await import("/src/backend/creationClient.ts");
    const models = await request("/model-configs");
    const config = models.find((model) => model.kind === "image");
    const source = createNode(
      "text",
      { x: 100, y: 180 },
      { title: "版本参考", text: "Reference version one", mediaRole: "asset" },
    );
    const target = createNode(
      "image",
      { x: 570, y: 180 },
      {
        title: "历史图片",
        prompt: "Original image prompt",
        settings: {
          mode: "image",
          model: config.modelId,
          modelConfigId: config.id,
          aspectRatio: "1:1",
          resolution: "1024",
          count: 1,
          prompt: "Original image prompt",
        },
      },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("History browser"),
      nodes: [source, target],
      edges: [
        { id: crypto.randomUUID(), source: source.id, target: target.id },
      ],
      viewport: { x: 0, y: 0, zoom: 0.85 },
    });
    const client = creationClient(saved.id);
    const initialSpec = client.snapshot.generationSpecs.find(
      (spec) => spec.kind === "image",
    );
    const reference = client.snapshot.references.find((ref) => ref.active);
    await client.command(
      "generationSpec.setPrompt",
      {
        specId: initialSpec.id,
        prompt: "Original image prompt before reference after reference",
        promptContent: [
          { type: "text", text: "Original image prompt before reference " },
          { type: "reference", referenceId: reference.id },
          { type: "text", text: " after reference" },
        ],
      },
      [objectVersion("generation_spec", initialSpec)],
    );
    await client.submit(target.id);
    for (let n = 0; n < 100; n++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.refresh();
      if (client.snapshot.jobs[0]?.status === "succeeded") break;
    }
    if (client.snapshot.jobs[0]?.status !== "succeeded")
      throw new Error(JSON.stringify(client.snapshot.jobs));
    const snapshot = client.snapshot;
    const old = currentAsset(
      snapshot,
      snapshot.canvasItems.find((item) => item.id === source.id),
    );
    const written = await client.writeText("new.md", "Reference version two", {
      assetId: old.id,
      revision: old.revision,
      fingerprint: old.fingerprint,
      kind: old.kind,
    });
    const item = client.snapshot.canvasItems.find(
      (item) => item.id === source.id,
    );
    await client.command(
      "canvas.materialize",
      { itemId: source.id, asset: written },
      [objectVersion("canvas_item", item)],
    );
    const spec = client.snapshot.generationSpecs.find(
      (spec) => spec.kind === "image",
    );
    await client.command(
      "generationSpec.setPrompt",
      { specId: spec.id, prompt: "Changed prompt" },
      [objectVersion("generation_spec", spec)],
    );
    await client.submit(target.id);
    for (let n = 0; n < 100; n++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.refresh();
      if (client.snapshot.jobs.at(-1)?.status === "succeeded") break;
    }
    if (client.snapshot.jobs.at(-1)?.status !== "succeeded")
      throw new Error("Second generation failed");
    client.close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return {
      id: saved.id,
      source: source.id,
      target: target.id,
      originalAsset: old.id,
      newAsset: written.assetId,
    };
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const source = page.locator(`.react-flow__node[data-id="${fixture.source}"]`);
  const target = page.locator(`.react-flow__node[data-id="${fixture.target}"]`);
  await source.getByRole("button", { name: "历史版本，共 2 个" }).waitFor();
  await page.evaluate(async (id) => {
    const client = (
      await import("/src/backend/creationClient.ts")
    ).creationClient(id);
    const { workspaceProjection } = await import("/src/backend/workspace.ts");
    const projection = workspaceProjection(id);
    const batch = client.batch.bind(client),
      view = client.view.bind(client),
      save = projection.save.bind(projection);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.historyReadCheck = {
      release,
      views: 0,
      finished: false,
      restore: () => {
        client.batch = batch;
        client.view = view;
        projection.save = save;
      },
    };
    // Opening history flushes through projection.save. A clean canvas never
    // reaches batch, so hold the flush the dialog actually awaits.
    projection.save = async (...args) => {
      await gate;
      try {
        return await save(...args);
      } finally {
        window.historyReadCheck.finished = true;
      }
    };
    client.batch = async (...args) => {
      await gate;
      return batch(...args);
    };
    client.view = async (...args) => {
      window.historyReadCheck.views++;
      return view(...args);
    };
  }, fixture.id);
  await target.getByRole("button", { name: "历史版本，共 2 个" }).click();
  const dialog = page.getByRole("dialog", { name: "节点历史版本" });
  await dialog.waitFor({ timeout: 1500 });
  await dialog.getByText("正在保存当前修改…", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "应用到画布" }).isEnabled(),
    false,
  );
  await dialog.getByRole("button", { name: "关闭历史版本" }).click();
  await page.evaluate(() => window.historyReadCheck.release());

  await page.waitForFunction(() => window.historyReadCheck.finished);
  assert.equal(await dialog.count(), 0);
  await target.getByRole("button", { name: "历史版本，共 2 个" }).click();
  await dialog.locator(".cw-version-prompt").first().waitFor();
  assert.equal(await page.evaluate(() => window.historyReadCheck.views), 0);
  await page.evaluate(() => window.historyReadCheck.restore());

  assert.equal(
    await dialog.getByText("历史提示词", { exact: true }).count(),
    0,
  );
  assert.equal(
    await dialog.getByText("当时的参考素材", { exact: true }).count(),
    0,
  );
  assert.equal(await dialog.locator(".cw-version-entry").count(), 2);
  const versionAssets = await dialog
    .locator(".cw-version-entry")
    .evaluateAll((items) => items.map((item) => item.dataset.versionAssetId));
  const generatedAssets = await page.evaluate(
    async (id) =>
      (await import("/src/backend/creationClient.ts"))
        .creationClient(id)
        .snapshot.jobs.map((job) => job.asset.assetId),
    fixture.id,
  );
  assert.deepEqual(versionAssets, generatedAssets);
  assert.equal(
    await dialog
      .locator('[data-current-version="true"]')
      .getAttribute("data-version-asset-id"),
    generatedAssets.at(-1),
  );
  assert.equal(
    await dialog.getByRole("button", { name: "重新读取" }).count(),
    0,
  );
  assert.equal(await dialog.locator(".cw-version-heading").count(), 0);
  const fixedBounds = await dialog.boundingBox();
  assert.equal(fixedBounds.width, 560);
  assert.equal(fixedBounds.height, 210);

  const layout = await dialog
    .locator(".cw-version-details")
    .first()
    .evaluate((element) => {
      const preview = element.children[0].getBoundingClientRect();
      const composer = element.children[1].getBoundingClientRect();
      return {
        sideBySide: preview.right <= composer.left,
        aligned: Math.abs(preview.top - composer.top) < 2,
        compact:
          preview.height <= 200 &&
          Math.abs(composer.height - preview.height) < 2,
        proportion: composer.width / preview.width > 2.7,
        fill:
          getComputedStyle(element.querySelector("img")).objectFit === "cover",
      };
    });
  assert.deepEqual(layout, {
    sideBySide: true,
    aligned: true,
    compact: true,
    proportion: true,
    fill: true,
  });
  assert.match(
    await dialog.locator(".cw-version-prompt").first().innerText(),
    /Original image prompt/,
  );
  const inlineReference = dialog
    .locator(".cw-version-prompt [data-history-reference]")
    .first();
  await inlineReference.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector(".cw-version-prompt [data-history-reference]")
      ?.getAttribute("title")
      ?.includes("Reference version one"),
  );
  assert.equal(
    await inlineReference.getAttribute("data-asset-id"),
    fixture.originalAsset,
  );
  const inlineOrder = await dialog
    .locator(".cw-version-prompt")
    .first()
    .evaluate((element) =>
      Array.from(element.childNodes).map((node) => node.textContent),
    );
  assert.deepEqual(inlineOrder, [
    "Original image prompt before reference ",
    "版本参考",
    " after reference",
  ]);
  assert.equal(
    await dialog
      .getByRole("radio")
      .first()
      .locator(".cw-version-slot-references")
      .count(),
    0,
  );
  assert.match(
    await dialog.locator(".cw-version-options").first().innerText(),
    /1 张/,
  );
  assert.match(
    await dialog.locator(".cw-version-options").first().innerText(),
    /自由创作/,
  );
  await dialog.locator("img").first().waitFor();
  await page.screenshot({ path: "/tmp/opendirector-node-version-history.png" });
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "light"),
  );
  await page.screenshot({
    path: "/tmp/opendirector-node-version-history-light.png",
    animations: "disabled",
  });
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  const before = await page.evaluate(
    async (id) =>
      (await import("/src/backend/creationClient.ts")).creationClient(id)
        .snapshot,
    fixture.id,
  );
  await dialog.getByRole("button", { name: "应用到画布", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByText(
      "历史版本已应用。部分参考与历史版本不同，已使用来源节点当前内容。",
      { exact: true },
    )
    .waitFor();
  const after = await page.evaluate(async (id) => {
    const client = (
      await import("/src/backend/creationClient.ts")
    ).creationClient(id);
    await client.refresh();
    return client.snapshot;
  }, fixture.id);
  assert.deepEqual(
    after.canvasItems.find((item) => item.id === fixture.source),
    before.canvasItems.find((item) => item.id === fixture.source),
  );
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.results, before.results);
  const pin = after.references.find((ref) => ref.active);
  assert.equal(pin.binding, "follow_current");
  assert.equal(pin.source.id, fixture.source);
  assert.match(
    after.generationSpecs.find((spec) => spec.kind === "image").prompt,
    /Original image prompt/,
  );
  const projection = await page.evaluate(
    async (id) =>
      (await import("/src/backend/api.ts")).request(
        `/creation/projects/${id}/canvas`,
      ),
    fixture.id,
  );
  assert.equal(
    projection.edges.find((edge) => edge.referenceId === pin.id).state,
    "pending",
  );

  await target.getByRole("button", { name: "历史版本，共 2 个" }).click();
  await dialog.getByRole("radio").first().waitFor();
  assert.deepEqual(
    await dialog
      .locator(".cw-version-entry")
      .evaluateAll((items) => items.map((item) => item.dataset.versionAssetId)),
    generatedAssets,
  );
  assert.equal(
    await dialog
      .locator('[data-current-version="true"]')
      .getAttribute("data-version-asset-id"),
    generatedAssets[0],
  );
  await dialog.getByRole("button", { name: "关闭历史版本" }).click();
  await target.click();
  const composerReference = page.locator(".cw-composer-dock [data-reference]");
  await composerReference.waitFor();
  assert.equal(await page.locator(".cw-frozen-reference-strip").count(), 0);
  assert.equal(
    await composerReference.locator(".cw-chat-reference-label").innerText(),
    "版本参考",
  );
  assert.equal(
    await composerReference.evaluate(
      (element) => getComputedStyle(element).borderTopStyle,
    ),
    "solid",
  );
  // Material history has no invented generation prompt; restore old text via UI.
  await source.getByRole("button", { name: "历史版本，共 2 个" }).click();
  await dialog.getByRole("radio", { name: "历史版本 1", exact: true }).click();
  await dialog.getByText("Reference version one", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByText("历史提示词", { exact: true }).count(),
    0,
  );
  await dialog.getByRole("button", { name: "应用到画布", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await source.getByRole("button", { name: "历史版本，共 2 个" }).waitFor();
  const reopened = await page.evaluate(
    async (id) =>
      (await import("/src/backend/api.ts")).request(
        `/creation/projects/${id}/canvas`,
      ),
    fixture.id,
  );
  assert.equal(
    reopened.edges.find((edge) => edge.referenceId === pin.id).state,
    "used",
  );
  assert.equal(
    reopened.snapshot.canvasItems.find((item) => item.id === fixture.source)
      .binding.objectRef.assetId,
    fixture.originalAsset,
  );
  assert.deepEqual(reopened.snapshot.jobs, before.jobs);
  await target.click();
  await composerReference.waitFor();
  assert.equal(
    await composerReference.evaluate(
      (element) => getComputedStyle(element).borderTopStyle,
    ),
    "solid",
  );
  // A fixed image chip uses its original asset preview and the logical node title.
  const imagePin = await page.evaluate(
    async ({ projectId, targetId }) => {
      const { creationClient, objectVersion } =
        await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      const old = client.snapshot.jobs[0].asset;
      const current = client.snapshot.jobs[1].asset;
      const id = crypto.randomUUID();
      await client.command("canvas.show", {
        item: {
          id,
          projectId,
          kind: "image",
          title: "图片上游",
          position: { x: 100, y: 480 },
          width: 180,
          height: 180,
          binding: { role: "material", objectRef: current },
        },
      });
      const item = client.snapshot.canvasItems.find((item) => item.id === id);
      const spec = client.snapshot.generationSpecs.find(
        (spec) => spec.kind === "image",
      );
      const refId = crypto.randomUUID();
      await client.command(
        "reference.add",
        {
          reference: {
            id: refId,
            projectId,
            targetSpecId: spec.id,
            binding: "pinned",
            source: old,
            sourceVersion: objectVersion("canvas_item", item),
            role: "reference",
            order: 1,
          },
        },
        [objectVersion("generation_spec", spec)],
      );
      const updated = client.snapshot.generationSpecs.find(
        (value) => value.id === spec.id,
      );
      await client.command(
        "generationSpec.setPrompt",
        {
          specId: spec.id,
          prompt: "Before image after image",
          promptContent: [
            { type: "text", text: "Before image " },
            { type: "reference", referenceId: refId },
            { type: "text", text: " after image" },
          ],
        },
        [objectVersion("generation_spec", updated)],
      );
      return {
        id,
        assetId: old.assetId,
        refId,
        url: await client.mediaUrl(old.assetId),
      };
    },
    { projectId: fixture.id, targetId: fixture.target },
  );
  await target.click();
  const imageChip = page
    .locator(`.cw-composer-dock [data-reference]`)
    .filter({ hasText: "图片上游" });
  await imageChip.locator("img").waitFor();
  assert.equal(
    await imageChip.locator("img").getAttribute("src"),
    imagePin.url,
  );
  assert.equal(
    await imageChip.evaluate(
      (element) => getComputedStyle(element).borderTopStyle,
    ),
    "solid",
  );
  assert.equal(
    await imageChip.evaluate(
      (element) => JSON.parse(element.dataset.reference).assetId,
    ),
    imagePin.assetId,
  );
  assert.equal(await page.locator(".cw-frozen-reference-strip").count(), 0);
  await page.screenshot({
    path: "/tmp/opendirector-applied-history-reference.png",
  });
  // Applying a generated image version replaces its old reference with live source content.
  const currentImage = await page.evaluate(
    async ({ projectId, targetId, sourceId }) => {
      const { creationClient, currentAsset } =
        await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.submit(targetId);
      for (let index = 0; index < 100; index++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.refresh();
        if (client.snapshot.jobs.at(-1)?.status === "succeeded") break;
      }
      if (client.snapshot.jobs.at(-1)?.status !== "succeeded")
        throw new Error("Image reference generation failed");
      const source = client.snapshot.canvasItems.find(
        (item) => item.id === sourceId,
      );
      const asset = currentAsset(client.snapshot, source);
      return {
        url: await client.mediaUrl(asset.id),
        jobs: client.snapshot.jobs,
      };
    },
    { projectId: fixture.id, targetId: fixture.target, sourceId: imagePin.id },
  );
  await target.getByRole("button", { name: "历史版本，共 3 个" }).click();
  await dialog.getByRole("radio", { name: "历史版本 3", exact: true }).click();
  await dialog.getByRole("button", { name: "应用到画布", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByText(
      "历史版本已应用。部分参考与历史版本不同，已使用来源节点当前内容。",
      { exact: true },
    )
    .last()
    .waitFor();
  await target.click();
  await imageChip.locator("img").waitFor();
  await page.waitForFunction(
    ({ url }) =>
      Array.from(
        document.querySelectorAll(".cw-composer-dock [data-reference] img"),
      ).some((img) => img.src === url),
    currentImage,
  );
  assert.equal(
    await imageChip.locator("img").getAttribute("src"),
    currentImage.url,
  );
  assert.equal(
    await imageChip.evaluate(
      (element) => getComputedStyle(element).borderTopStyle,
    ),
    "solid",
  );
  const followed = await page.evaluate(
    async ({ projectId, referenceId }) => {
      const client = (
        await import("/src/backend/creationClient.ts")
      ).creationClient(projectId);
      return {
        reference: client.snapshot.references.find(
          (ref) => ref.id === referenceId,
        ),
        jobs: client.snapshot.jobs,
      };
    },
    { projectId: fixture.id, referenceId: imagePin.refId },
  );
  assert.equal(followed.reference.binding, "follow_current");
  assert.equal(followed.reference.source.id, imagePin.id);
  assert.deepEqual(followed.jobs, currentImage.jobs);
  await page.locator(".cw-composer-dismiss").click();
  // Verify the same history UI with real MP4/WAV files, not synthetic URLs.
  for (const kind of ["video", "audio"]) {
    const args =
      kind === "video"
        ? [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=96x64:r=10",
            "-t",
            "0.3",
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "frag_keyframe+empty_moov",
            "-f",
            "mp4",
            "pipe:1",
          ]
        : [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=8000",
            "-t",
            "0.3",
            "-threads",
            "1",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
          ];
    const bytes = [...execFileSync("ffmpeg", args)];
    const itemId = await page.evaluate(
      async ({ projectId, kind, bytes }) => {
        const client = (
          await import("/src/backend/creationClient.ts")
        ).creationClient(projectId);
        const suffix = kind === "video" ? "mp4" : "wav";
        const asset = await client.importBlob(
          new Blob([Uint8Array.from(bytes)], { type: `${kind}/${suffix}` }),
          `history.${suffix}`,
          kind,
        );
        const id = crypto.randomUUID();
        await client.command("canvas.show", {
          item: {
            id,
            projectId,
            kind,
            title: `History ${kind}`,
            position: { x: kind === "video" ? 100 : 550, y: 600 },
            width: 352,
            height: 198,
            binding: { role: "material", objectRef: asset },
          },
        });
        return id;
      },
      { projectId: fixture.id, kind, bytes },
    );
    const mediaNode = page.locator(`.react-flow__node[data-id="${itemId}"]`);
    await mediaNode.waitFor();
    await page.waitForTimeout(400);
    assert.equal(await mediaNode.locator(".cw-node-version-button").count(), 0);
    await page.evaluate(
      async ({ projectId, itemId, kind, bytes }) => {
        const { creationClient, objectVersion } =
          await import("/src/backend/creationClient.ts");
        const client = creationClient(projectId);
        const suffix = kind === "video" ? "mp4" : "wav";
        const asset = await client.importBlob(
          new Blob([Uint8Array.from(bytes)], { type: `${kind}/${suffix}` }),
          `replacement.${suffix}`,
          kind,
        );
        const item = client.snapshot.canvasItems.find(
          (item) => item.id === itemId,
        );
        await client.command("canvas.materialize", { itemId, asset }, [
          objectVersion("canvas_item", item),
        ]);
      },
      { projectId: fixture.id, itemId, kind, bytes },
    );
    await mediaNode.getByRole("button", { name: "历史版本，共 2 个" }).click();
    await dialog.locator(kind).first().waitFor();
    await page.waitForFunction(
      (kind) =>
        document.querySelector(`.cw-version-dialog ${kind}`)?.readyState >= 1,
      kind,
    );
    await dialog
      .getByRole("button", { name: "应用到画布", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    if (kind === "audio") {
      await page.evaluate(
        async ({ projectId, itemId, bytes }) => {
          const { creationClient, objectVersion } =
            await import("/src/backend/creationClient.ts");
          const client = creationClient(projectId);
          for (let index = 0; index < 7; index++) {
            const asset = await client.importBlob(
              new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
              `version-${index}.wav`,
              "audio",
            );
            const item = client.snapshot.canvasItems.find(
              (item) => item.id === itemId,
            );
            await client.command("canvas.materialize", { itemId, asset }, [
              objectVersion("canvas_item", item),
            ]);
          }
        },
        { projectId: fixture.id, itemId, bytes },
      );
      await mediaNode
        .getByRole("button", { name: "历史版本，共 9 个" })
        .click();
      await dialog.locator(".cw-version-entry").last().waitFor();
      const manyBounds = await dialog.boundingBox();
      assert.equal(manyBounds.width, fixedBounds.width);
      assert.equal(manyBounds.height, fixedBounds.height);
      const list = dialog.locator(".cw-version-list");
      const footerY = (await dialog.locator("footer").boundingBox()).y;
      assert.equal(
        await list.evaluate((el) => el.scrollHeight > el.clientHeight),
        true,
      );
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      assert.ok(await list.evaluate((el) => el.scrollTop > 0));
      assert.equal((await dialog.locator("footer").boundingBox()).y, footerY);
      await dialog.getByRole("radio").last().click();
      assert.equal((await dialog.boundingBox()).height, fixedBounds.height);
      await page.screenshot({
        path: "/tmp/opendirector-fixed-history-scroll.png",
      });
      await dialog.getByRole("button", { name: "关闭历史版本" }).click();
    }
  }
  // A failed draft flush keeps the visible dialog blocked; reopening can retry.
  await page.evaluate(async (id) => {
    const { workspaceProjection } = await import("/src/backend/workspace.ts");
    const projection = workspaceProjection(id);
    const save = projection.save.bind(projection);
    window.restoreHistoryBatch = () => {
      projection.save = save;
    };
    // A clean canvas does not call batch. The dialog awaits this flush.
    projection.save = async () => {
      throw new Error("模拟草稿保存失败");
    };
  }, fixture.id);
  await target.getByRole("button", { name: "历史版本，共 3 个" }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "模拟草稿保存失败" })
    .waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "应用到画布" }).isEnabled(),
    false,
  );
  assert.equal(await dialog.locator(".cw-version-entry").count(), 0);
  await dialog.getByRole("button", { name: "关闭历史版本" }).click();
  await page.evaluate(() => window.restoreHistoryBatch());
  await target.getByRole("button", { name: "历史版本，共 3 个" }).click();
  await dialog.getByRole("radio").first().waitFor();
  await dialog.getByRole("button", { name: "关闭历史版本" }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId: fixture.id,
      checks: [
        "instant dialog during draft flush; no view writes; safe dismissal and save failure",
        "single version button hidden; count includes current",
        "all versions in creation order, including current",
        "fixed 560x210 window; multiple versions scroll with stationary footer",
        "compact 1:2.8 layout and cover preview",
        "inline references preserve body position and historical asset",
        "frozen prompt and reference preview",
        "apply generated version",
        "no duplicate preview; source title and frozen image thumbnail",
        "all inline references solid; apply follows current source and warns on differences",
        "unchanged source and jobs",
        "pending edge",
        "manual text restore",
        "reload",
        "used edge",
        "real MP4/WAV history preview and apply",
      ],
    }),
  );
} finally {
  await browser.close();
}
