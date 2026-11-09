/** Isolated fixture + Vite only: @ must select the actual visible source identity. */
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
});
const video = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=96x64:r=10",
  "-t",
  "1",
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
]).toString("base64");
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==";
try {
  {
    const unified = true;
    const page = await browser.newPage({
      locale: "zh-CN",
      viewport: { width: 1600, height: 1000 },
    });
    // Skip the first-run model setup welcome; it covers the canvas.
    await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", async (response) => {
      if (response.status() >= 400 && response.url().includes("/commands"))
        console.error(await response.text());
    });
    const health = await (
      await page.request.get(base + "/api/creation-test-health", {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
    assert.equal(
      health.isolated,
      true,
      "Never use real projects or model endpoints",
    );
    const bootstrap = (url) =>
      url.origin === new URL(base).origin && url.pathname === "/";
    await page.route(bootstrap, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body></body></html>",
      }),
    );
    await page.goto(base + "/");
    const fixture = await page.evaluate(
      async ({ video, png, unified }) => {
        const { request, json } = await import("/src/backend/api.ts");
        const { createDocument, createNode } =
          await import("/src/canvas/model.ts");
        const { importWorkspaceDocument } =
          await import("/src/backend/workspace.ts");
        const { releaseBackendProject } =
          await import("/src/backend/projects.ts");
        const { creationClient, objectVersion } =
          await import("/src/backend/creationClient.ts");
        const { prepareReferences } =
          await import("/src/backend/generation.ts");
        const { uploadReferenceFile } =
          await import("/src/backend/referenceUploads.ts");
        const models = await request("/model-configs");
        const config =
          models.find((m) => m.modelId === "FastH3-Omni-fixture") ??
          (await request(
            "/model-configs",
            json("POST", {
              kind: "video",
              modelId: "FastH3-Omni-fixture",
              url: "http://127.0.0.1:12345/v1",
              apiKey: "",
              connectionType: "self_hosted",
              protocol: "vllm_omni",
              authMode: "none",
              videoAdapter: "fasth3",
            }),
          ));
        const src = "data:video/mp4;base64," + video;
        const source = createNode(
          "video",
          { x: 130, y: 150 },
          {
            title: "原版_时长裁剪.mp4",
            src,
            mediaRole: "asset",
            media: { width: 96, height: 64, durationSeconds: 1 },
          },
        );
        source.width = 200;
        source.height = 140;
        const images = [0, 1].map((index) => ({
          ...createNode(
            "image",
            { x: 380 + index * 220, y: 150 },
            {
              title: "女王.jpg.jpg",
              src: png,
              mediaRole: "asset",
              media: { width: 16, height: 16 },
            },
          ),
          width: 160,
          height: 160,
        }));
        const hidden = { ...structuredClone(source), id: crypto.randomUUID() };
        const target = createNode(
          "video",
          { x: 850, y: 150 },
          {
            title: "当前生成节点",
            prompt: "保留原镜头，只替换人物。",
            settings: {
              mode: "video",
              model: config.modelId,
              modelConfigId: config.id,
              aspectRatio: "16:9",
              durationSeconds: 5,
              resolution: "480P",
              videoMode: "reference",
              prompt: "",
              count: 1,
            },
          },
        );
        target.width = 240;
        target.height = 160;
        const saved = await importWorkspaceDocument({
          ...createDocument(
            "Canvas reference " + crypto.randomUUID().slice(0, 8),
          ),
          nodes: [source, ...images, target, ...[hidden]],
          hiddenNodes: [],
          edges: [],
        });
        {
          const client = creationClient(saved.id);
          const item = client.snapshot.canvasItems.find(
            (item) => item.id === hidden.id,
          );
          await client.command("canvas.hide", { itemId: item.id }, [
            objectVersion("canvas_item", item),
          ]);
        }
        await uploadReferenceFile(
          saved.id,
          new File(["orphan inventory"], "未上画布.md", {
            type: "text/markdown",
          }),
          new AbortController().signal,
          async () => {
            throw new Error("Unexpected reuse");
          },
        );
        await releaseBackendProject();
        return {
          id: saved.id,
          source: source.id,
          hidden: hidden.id,
          images: images.map((image) => image.id),
          target: target.id,
        };
      },
      { video, png, unified },
    );
    await page.unroute(bootstrap);
    const url = `${base}/ai-tool/ai-canvas/${fixture.id}${""}`;
    await page.goto(url);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const target = page.locator(
      `.react-flow__node[data-id="${fixture.target}"]`,
    );
    await target.click();
    const editor = page.getByRole("textbox", {
      name: "生成提示词",
      exact: true,
    });
    const picker = page.getByRole("dialog", {
      name: "引用项目资产",
      exact: true,
    });
    await editor.fill("严格参考 @");
    await picker.waitFor();
    await picker.getByRole("option").first().waitFor();
    assert.equal(await picker.getByRole("option").count(), 3);
    assert.equal(
      await picker
        .getByRole("option", {
          name: "女王.jpg 图片 · 画布素材",
          exact: true,
        })
        .count(),
      2,
      "Independent identical-byte sources must stay distinct",
    );
    const option = picker.getByRole("option", {
      name: "原版_时长裁剪.mp4 视频 · 画布素材",
      exact: true,
    });
    assert.equal(
      await option.count(),
      1,
      "No hidden mirrors or inventory-only files",
    );
    await option.click();
    await picker.waitFor({ state: "hidden" });
    const ref = editor.locator("[data-reference]");
    await ref.waitFor();
    assert.equal(
      JSON.parse(await ref.getAttribute("data-reference")).nodeId,
      fixture.source,
    );
    await page.locator(".react-flow__edge").first().waitFor();
    await editor.press("End");
    await editor.press("Enter");
    await editor.pressSequentially("@");
    await picker
      .getByRole("option", { name: "女王.jpg 图片 · 画布素材", exact: true })
      .nth(1)
      .click();
    await picker.waitFor({ state: "hidden" });
    assert.deepEqual(
      await editor
        .locator("[data-reference]")
        .evaluateAll((elements) =>
          elements.map((el) => JSON.parse(el.dataset.reference).nodeId),
        ),
      [fixture.source, fixture.images[1]],
    );
    assert.equal(await page.locator(".react-flow__edge").count(), 2);
    const metrics = await editor.evaluate((element) => {
      const style = getComputedStyle(element);
      const line = parseFloat(style.lineHeight);
      return {
        font: style.fontSize,
        railFont: getComputedStyle(document.querySelector(".cw-rail-label"))
          .fontSize,
        line,
        heights: [...element.querySelectorAll(".cw-chat-reference")].map(
          (el) => el.getBoundingClientRect().height,
        ),
        previews: [
          ...element.querySelectorAll(
            ".cw-chat-reference img, .cw-chat-reference [data-reference-icon]:not([hidden])",
          ),
        ].map((el) => el.getBoundingClientRect().height),
      };
    });
    assert.equal(metrics.font, metrics.railFont);
    assert.ok(
      [...metrics.heights, ...metrics.previews].every(
        (height) => height <= metrics.line,
      ),
      JSON.stringify(metrics),
    );
    await page.getByRole("button", { name: "展开会话框", exact: true }).click();
    assert.equal(
      await editor.evaluate((el) => getComputedStyle(el).fontSize),
      metrics.font,
    );
    await page.getByRole("button", { name: "收起会话框", exact: true }).click();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    // Check authoritative persisted relationships, then reload their UI projection.
    const persisted = await page.evaluate(
      async ({ fixture, unified }) => {
        const { request } = await import("/src/backend/api.ts");
        {
        }
        const snapshot = await request(`/creation/projects/${fixture.id}`);
        return {
          sources: snapshot.references
            .filter((ref) => ref.active)
            .map((ref) => ref.source.id),
          hidden: snapshot.canvasItems
            .filter((item) => !item.visible)
            .map((item) => item.id),
        };
      },
      { fixture, unified },
    );
    assert.deepEqual(
      persisted.sources.sort(),
      [fixture.source, fixture.images[1]].sort(),
    );
    assert.ok(
      persisted.hidden.includes(fixture.hidden),
      "Keep hidden logical sources, omit only picker choices",
    );
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await target.click();
    assert.equal(await editor.locator("[data-reference]").count(), 2);
    assert.equal(await page.locator(".react-flow__edge").count(), 2);
    // A source can appear repeatedly in the prompt; removing its thumbnail
    // removes every occurrence of this relation, without deleting the source.
    await editor.press("Control+End");
    await page
      .getByRole("button", { name: "引用素材：原版_时长裁剪.mp4", exact: true })
      .click();
    assert.equal(await editor.locator("[data-reference]").count(), 3);
    const removeVideo = page.getByRole("button", {
      name: "移除参考：原版_时长裁剪.mp4",
      exact: true,
    });
    if (process.env.REFERENCE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.REFERENCE_SCREENSHOT_DIR}/reference-delete-${"unified"}.png`,
      });
    await removeVideo.click();
    assert.equal(await editor.locator("[data-reference]").count(), 1);
    assert.equal(await page.locator(".react-flow__edge").count(), 1);
    assert.equal(
      await page
        .locator(`.react-flow__node[data-id="${fixture.source}"]`)
        .count(),
      1,
    );
    assert.equal(
      await editor
        .locator("[data-reference]")
        .evaluate((element) => JSON.parse(element.dataset.reference).nodeId),
      fixture.images[1],
    );
    assert.equal(await removeVideo.count(), 0);
    await editor.press("Control+z");
    assert.equal(await editor.locator("[data-reference]").count(), 3);
    assert.equal(await page.locator(".react-flow__edge").count(), 2);
    await removeVideo.click();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await target.click();
    assert.equal(await editor.locator("[data-reference]").count(), 1);
    assert.equal(await page.locator(".react-flow__edge").count(), 1);
    // The same shared control removes image references with the keyboard.
    const removeImage = page.getByRole("button", {
      name: "移除参考：女王.jpg",
      exact: true,
    });
    await removeImage.focus();
    await removeImage.press("Enter");
    assert.equal(await editor.locator("[data-reference]").count(), 0);
    assert.equal(await page.locator(".react-flow__edge").count(), 0);
    assert.equal(await page.locator(".react-flow__node").count(), 4);
    assert.ok((await editor.innerText()).includes("严格参考"));
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const remaining = await page.evaluate(
      async ({ fixture, unified }) => {
        const { request } = await import("/src/backend/api.ts");
        {
          const snapshot = await request(`/creation/projects/${fixture.id}`);
          return {
            references: snapshot.references.filter((ref) => ref.active).length,
            sourceExists: snapshot.canvasItems.some(
              (item) => item.id === fixture.source && item.visible,
            ),
          };
        }
      },
      { fixture, unified },
    );
    assert.deepEqual(remaining, { references: 0, sourceExists: true });
    if (process.env.REFERENCE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.REFERENCE_SCREENSHOT_DIR}/reference-${"unified"}.png`,
      });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        mode: "unified",
        visibleSourceWires: true,
        authoritativeRelations: persisted.sources,
        hiddenRetained: true,
        thumbnailRemovalAndUndo: true,
        originalSourcesRetained: true,
        compactInline: metrics,
        reload: true,
        errors,
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
