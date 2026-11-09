/** Isolated fixture only: subject slots, uploads, playback and persisted layout. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const video = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=128x72:r=10",
  "-t",
  "6",
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
]);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1500, height: 1050 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const health = await page.request.get(base + "/api/creation-test-health", {
    headers: { "X-OpenDirector-Request": "1" },
  });
  assert.equal((await health.json()).isolated, true);
  {
    const libraryHeaders = {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    };
    const previousSubjects = await (
      await page.request.get(base + "/api/library/items?state=active", {
        headers: libraryHeaders,
      })
    ).json();
    if (previousSubjects.length)
      await page.request.post(base + "/api/library/items/trash", {
        headers: libraryHeaders,
        data: { itemIds: previousSubjects.map((item) => item.id) },
      });
    await page.request.delete(base + "/api/library/trash", {
      headers: libraryHeaders,
    });

    const bootstrap = (url) =>
      url.origin === new URL(base).origin && url.pathname === "/";
    await page.route(bootstrap, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body></body></html>",
      }),
    );
    await page.goto(base + "/");
    const fixture = await page.evaluate(async (video) => {
      const { createDocument, createNode, applyCommand } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const image = (id, hue) => {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 320;
        const context = canvas.getContext("2d");
        // Reusing this real PNG must exercise shared-media wire format 2.
        if (id === "主图-2") {
          const pixels = context.createImageData(240, 320);
          let seed = 12345;
          for (let i = 0; i < pixels.data.length; i += 4) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i] = seed & 255;
            pixels.data[i + 1] = (seed >>> 8) & 255;
            pixels.data[i + 2] = (seed >>> 16) & 255;
            pixels.data[i + 3] = 255;
          }
          context.putImageData(pixels, 0, 0);
        } else {
          context.fillStyle = `hsl(${hue},35%,28%)`;
          context.fillRect(0, 0, 240, 320);
        }
        context.fillStyle = `hsl(${hue},35%,75%)`;
        context.fillRect(70, 50, 100, 220);
        context.fillStyle = "#fff";
        context.font = "20px sans-serif";
        context.fillText(id, 15, 305);
        return {
          id,
          kind: "image",
          title: id,
          src: canvas.toDataURL(),
          mimeType: "image/png",
          width: 240,
          height: 320,
        };
      };
      const nodes = [0, 1, 2, 3].map((count, i) =>
        createNode(
          "subject",
          { x: 90 + (i % 3) * 400, y: 120 + Math.floor(i / 3) * 420 },
          {
            title: `附加图片 ${count}/3`,
            subject: {
              description:
                "主体描述仅供用户查看。主图片与右侧附加图片共同保留在主体中。",
              category: "character",
              main: image(`主图-${count}`, 140 + i * 30),
              auxiliaries: Array.from({ length: count }, (_, j) =>
                image(`附加-${count}-${j}`, 10 + j * 90),
              ),
            },
          },
        ),
      );
      const film = createNode(
        "subject",
        { x: 490, y: 540 },
        {
          title: "视频主体",
          subject: {
            description: "一份视频作为主体主素材。",
            category: "character",
            auxiliaries: [],
            main: {
              id: "video",
              kind: "video",
              title: "主体视频.mp4",
              mimeType: "video/mp4",
              src: "data:video/mp4;base64," + video,
              durationSeconds: 6,
              width: 128,
              height: 72,
            },
          },
        },
      );
      const locked = {
        ...createNode(
          "subject",
          { x: 890, y: 540 },
          {
            title: "锁定主体",
            subject: {
              description: "已锁定",
              category: "character",
              main: image("锁定主图", 60),
              auxiliaries: [],
            },
          },
        ),
        locked: true,
      };
      const blank = createNode(
        "subject",
        { x: 1290, y: 120 },
        { title: "Blank destination" },
      );
      const ordinary = createNode(
        "image",
        { x: 1290, y: 540 },
        {
          title: "Ordinary image",
          src: image("ordinary", 315).src,
          mediaRole: "asset",
        },
      );
      const audio = createNode(
        "audio",
        { x: 1290, y: 940 },
        { title: "Audio downstream" },
      );
      let original = {
        ...createDocument(
          "Subject transfer " + crypto.randomUUID().slice(0, 8),
        ),
        nodes: [...nodes, film, locked, blank, ordinary, audio],
        viewport: { x: 10, y: 10, zoom: 0.8 },
      };
      original = applyCommand(original, {
        type: "add-edge",
        edge: {
          id: crypto.randomUUID(),
          source: ordinary.id,
          target: nodes[1].id,
          intent: "assembly_input",
        },
      });
      original = applyCommand(original, {
        type: "add-edge",
        edge: {
          id: crypto.randomUUID(),
          source: nodes[1].id,
          target: audio.id,
          intent: "generation_input",
        },
      });
      const savedDocument = await importWorkspaceDocument(original);
      (await import("/src/backend/creationClient.ts"))
        .creationClient(savedDocument.id)
        .close();
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
      return {
        id: savedDocument.id,
        projectTitle: savedDocument.title,
        images: nodes.map((n) => n.id),
        video: film.id,
        blank: blank.id,
        ordinary: ordinary.id,
        audio: audio.id,
        title: nodes[2].data.title,
        videoTitle: film.data.title,
        originalCount: original.nodes.length,
        locked: locked.id,
        uploads: [200, 230, 260].map(
          (hue, i) => image(`上传-${i}`, hue).src.split(",")[1],
        ),
      };
    }, video.toString("base64"));
    await page.unroute(bootstrap);
    await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}${""}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
    const library = page.getByRole("dialog", { name: "资产库", exact: true });
    const picker = page.getByRole("dialog", { name: "导入主体", exact: true });
    const check = (dialog, title) =>
      dialog.getByRole("checkbox", { name: `选择：${title}`, exact: true });
    const confirm = () =>
      picker.getByRole("button", { name: "确定", exact: true });
    const closePicker = () =>
      picker.getByRole("button", { name: "关闭主体导入", exact: true }).click();
    const openLibrary = async (tab = "assets") => {
      await page
        .getByRole("toolbar", { name: "画布创作工具", exact: true })
        .getByRole("button", { name: "资产库", exact: true })
        .click();
      await library.waitFor();
      if (tab !== "assets")
        await library
          .getByRole("tab", {
            name: tab === "subjects" ? "主体" : "画布",
            exact: true,
          })
          .click();
    };
    const closeLibrary = () =>
      library.getByRole("button", { name: "关闭资产库", exact: true }).click();
    const openSubject = async (id) => {
      const card = node(id);
      await card.locator(".cw-subject-main,.cw-subject-video").first().hover();
      await card
        .getByRole("button", { name: "导入主体内容", exact: true })
        .click();
      await picker.waitFor();
    };
    const read = async () => {
      const response = await page.request.get(
        base + `/api/${"creation/projects/" + fixture.id}`,
        { headers: libraryHeaders },
      );
      assert.equal(response.status(), 200);
      const saved = await response.json();
      {
      }
      return {
        nodes: saved.canvasItems
          .filter((item) => item.visible)
          .map((item) => ({
            id: item.id,
            type: item.kind,
            data: {
              title: item.title,
              subject:
                item.binding.role === "editor"
                  ? (() => {
                      const data = saved.editorDocuments.find(
                        (doc) => doc.id === item.binding.objectRef.id,
                      )?.data;
                      if (!data) return undefined;
                      const resource = (ref) =>
                        ref
                          ? {
                              ...ref,
                              ...saved.assets.find(
                                (asset) => asset.id === ref.assetId,
                              )?.metadata,
                            }
                          : undefined;
                      return {
                        ...data,
                        main: resource(data.main),
                        auxiliaries: data.auxiliaries.map(resource),
                        voice: resource(data.voice),
                      };
                    })()
                  : undefined,
            },
          })),
        edges: saved.editorDocuments.flatMap(
          (doc) => doc.inputConnections ?? [],
        ),
      };
    };
    const waitForSaved = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        const state = await read();
        if (predicate(state)) return state;
        await page.waitForTimeout(100);
      }
      throw new Error("Expected saved state was not reached");
    };
    // Back up complete library subjects through the global library's management action.
    for (const [id, title] of [
      [fixture.images[2], fixture.title],
      [fixture.video, fixture.videoTitle],
    ]) {
      await node(id)
        .locator(".cw-subject-main,.cw-subject-video")
        .first()
        .click({ position: { x: 8, y: 8 } });
      await openLibrary("subjects");
      await library
        .getByRole("button", { name: "加入选中主体", exact: true })
        .click();
      await check(library, title).waitFor();
      await closeLibrary();
    }
    const upload = async (name, payload, mime) => {
      const response = await page.request.post(
        base + "/api/library/items/upload?name=" + encodeURIComponent(name),
        { headers: { ...libraryHeaders, "Content-Type": mime }, data: payload },
      );
      assert.equal(response.status(), 200, await response.text());
      return response.json();
    };
    const pictureA = await upload(
      "Selector picture A.png",
      Buffer.from(fixture.uploads[0], "base64"),
      "image/png",
    );
    const pictureB = await upload(
      "Selector picture B.png",
      Buffer.from(fixture.uploads[1], "base64"),
      "image/png",
    );
    const wav = (seconds) =>
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=8000:cl=mono",
        "-t",
        String(seconds),
        "-f",
        "wav",
        "pipe:1",
      ]);
    const voice15 = await upload("Voice 15.wav", wav(15), "audio/wav");
    const voice16 = await upload("Voice 16.wav", wav(16), "audio/wav");
    // Every blank-node entry opens the independent selector at the appropriate tab.
    for (const [entry, tab] of [
      ["导入主体", "主体"],
      ["从资产库选择", "资产库"],
      ["从画布选择", "当前画布"],
    ]) {
      await node(fixture.blank)
        .getByRole("button", { name: entry, exact: true })
        .click();
      await picker.waitFor();
      assert.equal(
        await picker
          .getByRole("tab", { name: tab, exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
      assert.equal(
        await picker
          .getByRole("button", { name: "本地添加", exact: true })
          .count(),
        0,
      );
      assert.equal(await confirm().isDisabled(), true);
      assert.equal(await library.count(), 0);
      await closePicker();
    }
    await node(fixture.blank)
      .getByRole("button", { name: "从资产库选择", exact: true })
      .click();
    await check(picker, pictureA.name).click();
    await check(picker, pictureB.name).click();
    assert.equal(
      await check(picker, pictureA.name).getAttribute("aria-checked"),
      "false",
    );
    assert.equal(await check(picker, voice15.name).isDisabled(), true);
    await picker.getByRole("tab", { name: "主体", exact: true }).click();
    assert.equal(await confirm().isDisabled(), true);
    await picker.getByRole("tab", { name: "资产库", exact: true }).click();
    await check(picker, pictureB.name).click();
    await confirm().click();
    await picker.waitFor({ state: "hidden" });
    let state = await waitForSaved((state) =>
      Boolean(
        state.nodes.find((item) => item.id === fixture.blank).data.subject.main,
      ),
    );
    const targetBefore = state.nodes.find((item) => item.id === fixture.blank);
    assert.equal(targetBefore.data.title, "Blank destination");
    assert.equal(targetBefore.data.subject.main.kind, "image");
    // The global library always creates a node, even when a populated subject is selected.
    await openLibrary();
    assert.equal(
      await library
        .getByRole("button", { name: "导入选中主体", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await library
        .getByRole("button", { name: "放入当前画布", exact: true })
        .count(),
      0,
    );
    await check(library, pictureA.name).click();
    await check(library, pictureB.name).click();
    assert.equal(
      await check(library, pictureA.name).getAttribute("aria-checked"),
      "false",
    );
    await library
      .getByRole("button", { name: "导入画布", exact: true })
      .click();
    await library.waitFor({ state: "hidden" });
    state = await waitForSaved(
      (state) => state.nodes.length === fixture.originalCount + 1,
    );
    assert.deepEqual(
      state.nodes.find((item) => item.id === fixture.blank).data.subject,
      targetBefore.data.subject,
    );
    await openLibrary("subjects");
    await check(library, fixture.title).click();
    await check(library, fixture.videoTitle).click();
    assert.equal(
      await check(library, fixture.title).getAttribute("aria-checked"),
      "false",
    );
    await library
      .getByRole("button", { name: "导入画布", exact: true })
      .click();
    await library.waitFor({ state: "hidden" });
    await waitForSaved(
      (state) => state.nodes.length === fixture.originalCount + 2,
    );
    // Whole-subject replacement clears old assembly and remains one undo step.
    await openSubject(fixture.images[1]);
    await check(picker, fixture.title).click();
    await confirm().click();
    await picker.waitFor({ state: "hidden" });
    await waitForSaved((state) =>
      Boolean(
        state.nodes.find((item) => item.id === fixture.images[1]).data.subject
          .librarySource,
      ),
    );
    await page.waitForTimeout(1100);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await waitForSaved(
      (state) =>
        !state.nodes.find((item) => item.id === fixture.images[1]).data.subject
          .librarySource,
    );
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await waitForSaved((state) =>
      Boolean(
        state.nodes.find((item) => item.id === fixture.images[1]).data.subject
          .librarySource,
      ),
    );
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(
            `.react-flow__node[data-id="${id}"] .cw-subject-main img`,
          )
          ?.getAttribute("alt")
          ?.includes("main") === true,
      fixture.images[1],
    );
    await openSubject(fixture.images[1]);
    await check(picker, fixture.videoTitle).click();
    await confirm().click();
    await picker.getByRole("status").filter({ hasText: "不兼容" }).waitFor();
    await closePicker();
    // Current-canvas sources retain full subjects and support single selection without new nodes or edges.
    await openSubject(fixture.blank);
    await picker.getByRole("tab", { name: "当前画布", exact: true }).click();
    await check(picker, "Ordinary image").click();
    await check(picker, fixture.title).click();
    assert.equal(
      await check(picker, "Ordinary image").getAttribute("aria-checked"),
      "false",
    );
    await confirm().click();
    await picker.waitFor({ state: "hidden" });
    state = await waitForSaved(
      (state) =>
        state.nodes.find((item) => item.id === fixture.blank).data.subject
          .auxiliaries.length === 2,
    );
    assert.equal(state.nodes.length, fixture.originalCount + 2);
    // Voice slot allows 15s and blocks 16s; it keeps the image and auxiliary slots.
    await node(fixture.blank)
      .getByRole("button", { name: "添加主体声音", exact: true })
      .click();
    await picker.waitFor();
    await check(picker, voice15.name).waitFor();
    assert.equal(await check(picker, voice16.name).isDisabled(), true);
    await check(picker, voice15.name).click();
    await confirm().click();
    await picker.waitFor({ state: "hidden" });
    state = await waitForSaved((state) =>
      Boolean(
        state.nodes.find((item) => item.id === fixture.blank).data.subject
          .voice,
      ),
    );
    assert.equal(
      state.nodes.find((item) => item.id === fixture.blank).data.subject.voice
        .durationSeconds,
      15,
    );
    assert.equal(
      state.nodes.find((item) => item.id === fixture.blank).data.subject
        .auxiliaries.length,
      2,
    );
    // Browse current canvas through the global library and copy a node independently.
    await openLibrary("canvases");
    await library
      .getByRole("button", { name: fixture.projectTitle, exact: true })
      .click();
    await check(library, "Ordinary image").click();
    await library
      .getByRole("button", { name: "导入画布", exact: true })
      .click();
    await library.waitFor({ state: "hidden" });
    await waitForSaved(
      (state) => state.nodes.length === fixture.originalCount + 3,
    );
    // Library deletion does not break already imported owned media or provenance.
    const subjects = await (
      await page.request.get(base + "/api/library/subjects", {
        headers: libraryHeaders,
      })
    ).json();
    await page.request.post(base + "/api/library/items/trash", {
      headers: libraryHeaders,
      data: { itemIds: subjects.map((item) => item.id) },
    });
    await page.request.delete(base + "/api/library/trash", {
      headers: libraryHeaders,
    });
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    state = await waitForSaved(
      (state) => state.nodes.length === fixture.originalCount + 3,
    );
    assert.equal(
      state.nodes.find((item) => item.id === fixture.blank).data.subject.voice
        .durationSeconds,
      15,
    );
    assert.equal(
      await node(fixture.blank)
        .locator(".cw-subject-main img")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
      true,
    );
    console.log(
      JSON.stringify({
        mode: "unified",
        independentSelector: true,
        entryTabs: true,
        singleSelection: true,
        globalCreateOnly: true,
        fullCanvasSubject: true,
        voice15Accepted16Rejected: true,
        oneStepUndoRedo: true,
        independentAfterPurge: true,
      }),
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, pageErrors: errors }));
} catch (error) {
  await page.screenshot({
    path: "/tmp/opendirector-subject-picker-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
