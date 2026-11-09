/** Isolated API fixture; delayed list pages exercise progressive loading. */
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
  "color=c=blue:s=96x64:r=5",
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
const audio = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=16000",
  "-t",
  "1",
  "-f",
  "wav",
  "pipe:1",
]).toString("base64");
let releasePage;
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
  await page.goto(base);
  const projectId = await page.evaluate(
    async ({ video, audio }) => {
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const saved = await importWorkspaceDocument({
        ...createDocument("Asset listing " + crypto.randomUUID().slice(0, 8)),
        nodes: [
          createNode(
            "image",
            { x: 100, y: 100 },
            {
              title: "Original image.png",
              mediaRole: "asset",
              src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
            },
          ),
          createNode(
            "video",
            { x: 500, y: 100 },
            {
              title: "画布视频",
              mediaRole: "asset",
              src: "data:video/mp4;base64," + video,
              media: { width: 96, height: 64, durationSeconds: 1 },
            },
          ),
          createNode(
            "audio",
            { x: 100, y: 500 },
            {
              title: "画布音频",
              mediaRole: "asset",
              src: "data:audio/wav;base64," + audio,
              media: { durationSeconds: 1 },
            },
          ),
        ],
      });
      const { creationClient, objectVersion, assetReference } =
        await import("/src/backend/creationClient.ts");
      const client = creationClient(saved.id);
      const item = client.snapshot.canvasItems[0];
      await client.command(
        "canvas.update",
        { itemId: item.id, title: "画布图片" },
        [objectVersion("canvas_item", item)],
      );
      const asset = client.snapshot.assets.find(
        (asset) => asset.id === item.binding.objectRef.assetId,
      );
      const subjectId = crypto.randomUUID(),
        timelineId = crypto.randomUUID();
      await client.command("creation.batch", {
        operations: [
          {
            type: "editor.create",
            payload: {
              document: {
                id: subjectId,
                projectId: saved.id,
                kind: "subject",
                data: { main: assetReference(asset) },
              },
            },
          },
          {
            type: "canvas.show",
            payload: {
              item: {
                id: crypto.randomUUID(),
                projectId: saved.id,
                kind: "subject",
                title: "主体_霜烟",
                binding: {
                  role: "editor",
                  objectRef: { id: subjectId, kind: "subject" },
                },
              },
            },
          },
          {
            type: "editor.create",
            payload: {
              document: {
                id: timelineId,
                projectId: saved.id,
                kind: "timeline",
                data: {
                  fps: 30,
                  width: 1920,
                  height: 1080,
                  tracks: [
                    {
                      id: "visual",
                      kind: "visual",
                      title: "Visual",
                      clips: [
                        {
                          id: "clip",
                          inPoint: 0,
                          outPoint: 2,
                          resource: {
                            asset: assetReference(asset),
                            title: "Image",
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
          {
            type: "canvas.show",
            payload: {
              item: {
                id: crypto.randomUUID(),
                projectId: saved.id,
                kind: "timeline",
                title: "时间线_场景",
                binding: {
                  role: "editor",
                  objectRef: { id: timelineId, kind: "timeline" },
                },
              },
            },
          },
        ],
      });
      client.close();
      await releaseBackendProject();
      return saved.id;
    },
    { video, audio },
  );
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  // Only listing responses are simulated; project save and open use the API.
  const rows = Array.from({ length: 201 }, (_, index) => ({
    asset: {
      id: crypto.randomUUID(),
      name: `Asset ${index}`,
      kind: "text",
      metadata: { size: 0, mimeType: "text/plain" },
    },
    usage: { used: false, reasons: [], hiddenItemIds: [] },
    owners: [],
    specId: null,
    createdOrder: index,
  }));
  let cursorMismatch = false;
  const queries = [];
  const secondPage = new Promise((resolve) => (releasePage = resolve));
  await page.route(
    `**/creation/projects/${projectId}/asset-list?*`,
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const query = params.get("text");
      queries.push(query);
      const offset = Number(params.get("offset"));
      if (offset && !cursorMismatch) await secondPage;
      await route.fulfill({
        json: {
          items: query ? [rows[200]] : rows.slice(offset, offset + 200),
          total: query ? 1 : rows.length,
          eventCursor: cursorMismatch && offset ? 2 : 1,
          counts: {
            all: query ? 1 : rows.length,
            text: query ? 1 : rows.length,
            image: 0,
            video: 0,
            audio: 0,
            subject: 0,
            timeline: 0,
          },
        },
      });
    },
  );
  await page.getByRole("button", { name: "资产列表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "资产列表", exact: true });
  await dialog.getByRole("checkbox").first().waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 200);
  await dialog.getByRole("status").filter({ hasText: "200/201" }).waitFor();
  const layout = await dialog.boundingBox();
  assert.ok(
    layout.x > 1000 && layout.y < 100,
    "Panel must float in the upper right",
  );
  assert.equal(
    await page
      .locator("body")
      .evaluate(() => document.querySelectorAll(":modal").length),
    0,
  );
  const scrolling = await dialog
    .locator(".cw-creation-asset-rows")
    .evaluate((el) => ({ height: el.clientHeight, content: el.scrollHeight }));
  assert.ok(
    scrolling.content > scrolling.height,
    "Long lists must scroll within the floating panel",
  );
  assert.equal(await dialog.getByRole("tab").count(), 7);
  assert.equal(
    await dialog.getByRole("button", { name: /下一页|上一页/ }).count(),
    0,
  );
  releasePage();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Asset 200", exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 201);
  await dialog.press("Escape");
  assert.equal(await dialog.count(), 0);
  await page.getByRole("button", { name: "资产列表", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Asset 200", exact: true })
    .waitFor();
  await page.mouse.click(700, 700);
  assert.equal(await dialog.count(), 0);
  await page.getByRole("button", { name: "资产列表", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Asset 200", exact: true })
    .waitFor();
  const search = dialog.getByRole("textbox", { name: "查找资产" });
  const count = queries.length;
  await search.pressSequentially("Asset 200", { delay: 20 });
  await page.waitForFunction(
    () => document.querySelectorAll(".cw-creation-asset-row").length === 1,
  );
  assert.deepEqual(queries.slice(count), ["Asset 200"]);
  // Pages from different project revisions must never form a usable list.
  cursorMismatch = true;
  await search.fill("");
  await dialog
    .getByRole("alert")
    .filter({ hasText: "资产列表已变化" })
    .waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  cursorMismatch = false;
  await dialog.getByRole("button", { name: "重新读取资产列表" }).click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Asset 200", exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 201);
  await dialog.getByRole("button", { name: "关闭资产列表" }).click();
  await page.unroute(`**/creation/projects/${projectId}/asset-list?*`);
  await page.evaluate(async (projectId) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    await creationClient(projectId).command("asset.writeText", {
      name: "Actual asset.md",
      text: "Asset list integration check",
    });
  }, projectId);
  await page.getByRole("button", { name: "资产列表", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 4);
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .locator(
        ".cw-creation-asset-open > span:not(.cw-creation-asset-thumbnail)",
      )
      .filter({ hasText: "Original image.png" })
      .count(),
    0,
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".cw-creation-asset-thumbnail img")].some(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  assert.equal(
    await dialog.getByRole("button", { name: /^永久删除：/ }).count(),
    0,
  );
  assert.equal(
    await dialog.getByRole("button", { name: /^删除所选/ }).count(),
    0,
  );
  await dialog.getByRole("tab", { name: "图片 1", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".cw-creation-asset-row").length === 1,
  );
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  assert.equal(
    await dialog.getByRole("tab", { name: "全部 6", exact: true }).count(),
    1,
  );
  await dialog.getByRole("tab", { name: "主体 1", exact: true }).click();
  const subject = dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "主体_霜烟" });
  await subject.waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  await subject.hover();
  const subjectPreview = page.getByRole("tooltip", {
    name: "主体_霜烟预览",
    exact: true,
  });
  await subjectPreview.locator("img").waitFor();
  assert.ok(
    (await subjectPreview.boundingBox()).x < (await dialog.boundingBox()).x,
  );
  if (process.env.ASSET_LIST_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.ASSET_LIST_SCREENSHOT_DIR}/subject-list-hover.png`,
    });
  await dialog.getByRole("tab", { name: "时间线 1", exact: true }).click();
  await dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "时间线_场景" })
    .hover();
  await page
    .getByRole("tooltip", { name: "时间线_场景预览", exact: true })
    .locator("img")
    .waitFor();
  await dialog.getByRole("tab", { name: "视频 1", exact: true }).click();
  await dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "画布视频" })
    .hover();
  await page
    .getByRole("tooltip", { name: "画布视频预览", exact: true })
    .locator("video")
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-creation-asset-preview video")?.videoWidth >
      0,
  );

  await dialog.getByRole("tab", { name: "音频 1", exact: true }).click();
  await dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "画布音频" })
    .hover();
  await page
    .getByRole("tooltip", { name: "画布音频预览", exact: true })
    .getByText(/KB/)
    .waitFor();
  await dialog.getByRole("tab", { name: "文本 1", exact: true }).click();
  await dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "Actual asset.md" })
    .hover();
  await page
    .getByRole("tooltip", { name: "Actual asset.md预览", exact: true })
    .getByText("Asset list integration check")
    .waitFor();
  await dialog.getByRole("tab", { name: "全部 6", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
    .waitFor();
  const visibility = dialog.getByRole("combobox", { name: "资产显示状态" });
  assert.deepEqual(await visibility.locator("option").allTextContents(), [
    "全部",
    "已显示",
    "未显示",
  ]);
  const assetLabels = [
    "未在画布中显示·点击添加节点",
    "已在画布中显示·点击定位节点",
    "已在画布中显示·点击定位节点",
    "已在画布中显示·点击定位节点",
  ];
  const readAssetLabels = () =>
    dialog.locator(".cw-creation-asset-row").evaluateAll((rows) =>
      rows.flatMap((row) => {
        if (!row.querySelector("input")) return [];
        const label = row.querySelector(".cw-creation-asset-open small");
        return label ? [label.textContent] : [];
      }),
    );
  let labels = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    labels = await readAssetLabels();
    if (JSON.stringify(labels) === JSON.stringify(assetLabels)) break;
    await page.waitForTimeout(50);
  }
  assert.deepEqual(labels, assetLabels);
  await visibility.selectOption("visible");
  await page.waitForFunction(
    () => document.querySelectorAll(".cw-creation-asset-row").length === 5,
  );
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
      .count(),
    0,
  );
  await visibility.selectOption("hidden");
  await dialog
    .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
      .count(),
    0,
  );
  await visibility.selectOption("all");
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    const palette = await visibility
      .locator("option")
      .first()
      .evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color,
        scheme: getComputedStyle(el.parentElement).colorScheme,
      }));
    assert.equal(palette.scheme, theme);
    const active = dialog.getByRole("tab", { selected: true });
    assert.equal(
      await active.evaluate((el) => getComputedStyle(el).borderBottomWidth),
      "2px",
    );
    assert.equal(
      await active.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      palette.background,
      theme === "dark" ? "rgb(53, 48, 61)" : "rgb(227, 238, 255)",
    );
    assert.equal(
      palette.color,
      theme === "dark" ? "rgb(245, 237, 255)" : "rgb(36, 86, 185)",
    );
    if (process.env.ASSET_LIST_SCREENSHOT_DIR) {
      await page.waitForTimeout(350);
      await dialog.screenshot({
        path: `${process.env.ASSET_LIST_SCREENSHOT_DIR}/asset-list-${theme}.png`,
      });
    }
  }
  await dialog.getByRole("textbox", { name: "查找资产" }).fill("画布图片");
  await page.waitForFunction(
    () => document.querySelectorAll(".cw-creation-asset-row").length === 1,
  );
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  await dialog.getByRole("textbox", { name: "查找资产" }).fill("");
  await dialog
    .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
    .waitFor();
  await dialog
    .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "删除所选（1）", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "确认永久删除", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("checkbox", { name: "选择资产：Actual asset.md", exact: true })
      .count(),
    0,
  );
  await dialog
    .getByRole("checkbox", { name: "选择资产：画布图片", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "删除所选（1）", exact: true })
    .click();
  await dialog.getByText("画布中显示的节点", { exact: false }).waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "确认永久删除", exact: true })
      .count(),
    0,
  );
  await dialog
    .getByRole("button", { name: "关闭资产列表", exact: true })
    .click();
  const subjectId = await page.evaluate(async (projectId) => {
    const { creationClient, objectVersion } =
      await import("/src/backend/creationClient.ts");
    const client = creationClient(projectId);
    await client.refresh();
    const item = client.snapshot.canvasItems.find(
      (item) => item.title === "主体_霜烟",
    );
    await client.command("canvas.hide", { itemId: item.id }, [
      objectVersion("canvas_item", item),
    ]);
    return item.id;
  }, projectId);
  await page.waitForFunction(
    (id) => !document.querySelector(`.react-flow__node[data-id="${id}"]`),
    subjectId,
  );
  await page.getByRole("button", { name: "资产列表", exact: true }).click();
  await dialog.getByRole("tab", { name: "主体 1", exact: true }).click();
  const restore = dialog
    .locator(".cw-creation-asset-open")
    .filter({ hasText: "主体_霜烟" });
  await restore.getByText("已从画布中删除·点击恢复节点", { exact: true }).waitFor();
  assert.equal(await restore.locator(".is-removed").textContent(), "主体_霜烟");
  await restore.click();
  await page
    .locator(`.react-flow__node[data-id="${subjectId}"].selected`)
    .waitFor();
  assert.equal(await dialog.count(), 0);
  const savedSubject = await page.evaluate(async (projectId) => {
    const { request } = await import("/src/backend/api.ts");
    const snapshot = await request(`/creation/projects/${projectId}`);
    return snapshot.canvasItems.filter((item) => item.title === "主体_霜烟");
  }, projectId);
  assert.equal(savedSubject.length, 1);
  assert.equal(savedSubject[0].id, subjectId);
  assert.equal(savedSubject[0].visible, true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      firstPageBeforeCompletion: true,
      debouncedSearch: true,
      cursorConflictDiscarded: true,
      retry: true,
      realAssetQuery: true,
      nodeTitleAndThumbnail: true,
      visibilityFiltering: true,
      themedDropdown: true,
      floatingScrollablePanel: true,
      sixTypeCategories: true,
      escapeAndOutsideDismissal: true,
      subjectAndTimelineNames: true,
      allTypeHoverPreviews: true,
      hiddenSubjectRestoredAndLocated: true,
      selectedDeletionOnly: true,
      visibleAssetProtected: true,
      errors,
    }),
  );
} finally {
  releasePage?.();
  await browser.close();
}
