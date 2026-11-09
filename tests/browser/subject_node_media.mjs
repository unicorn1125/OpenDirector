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
    const unified = true;
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
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const image = (id, hue) => {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 320;
        const context = canvas.getContext("2d");
        context.fillStyle = `hsl(${hue},35%,28%)`;
        context.fillRect(0, 0, 240, 320);
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
      const savedDocument = await importWorkspaceDocument({
        ...createDocument(
          "Subject media layout " + crypto.randomUUID().slice(0, 8),
        ),
        nodes: [...nodes, film, locked],
        viewport: { x: 10, y: 10, zoom: 0.9 },
      });
      (await import("/src/backend/creationClient.ts"))
        .creationClient(savedDocument.id)
        .close();
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
      return {
        id: savedDocument.id,
        images: nodes.map((n) => n.id),
        video: film.id,
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
    for (const [count, id] of fixture.images.entries()) {
      const card = node(id);
      assert.equal(
        await card.locator(".cw-subject-auxiliary img").count(),
        count,
      );
      assert.equal(
        await card
          .getByRole("button", { name: "添加附加图片", exact: true })
          .count(),
        count < 3 ? 1 : 0,
      );
      const main = await card.locator(".cw-subject-main").boundingBox();
      const rail = await card.locator(".cw-subject-auxiliaries").boundingBox();
      assert.ok(main.width > rail.width * 2.5);
      assert.ok(Math.abs(main.height - rail.height) < 1);
      if (count < 3) {
        const plus = card.getByRole("button", {
          name: "添加附加图片",
          exact: true,
        });
        const box = await plus.boundingBox(),
          svg = await plus.locator("svg").boundingBox();
        assert.ok(Math.abs(box.x + box.width / 2 - svg.x - svg.width / 2) < 1);
        assert.ok(
          Math.abs(box.y + box.height / 2 - svg.y - svg.height / 2) < 1,
        );
        if (count === 0) assert.ok(Math.abs(box.height - rail.height) < 1);
      }
    }
    const videoBox = await node(fixture.video)
      .locator(".cw-subject-video")
      .boundingBox();
    assert.ok(
      Math.abs(videoBox.height - (videoBox.width * 72) / 128) < 2,
      "Video preview must follow its frame ratio",
    );
    assert.equal(
      await node(fixture.video).locator(".cw-subject-auxiliaries").count(),
      0,
    );
    assert.equal(
      await node(fixture.video)
        .getByRole("button", { name: "添加主体声音", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await node(fixture.locked)
        .getByRole("button", { name: "添加附加图片", exact: true })
        .isDisabled(),
      true,
    );
    for (const theme of ["dark", "light"]) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page
        .getByRole("combobox", { name: "主题", exact: true })
        .selectOption(theme);
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.screenshot({
        path: `/tmp/opendirector-subject-media-${"unified"}-${theme}.png`,
      });
    }
    const target = node(fixture.images[0]);
    const mainBefore = await target
      .locator(".cw-subject-main img")
      .getAttribute("src");
    const mainFingerprint = () =>
      target.locator(".cw-subject-main img").evaluate(async (element) => {
        const bytes = await (await fetch(element.src)).arrayBuffer();
        return Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ).join(",");
      });
    const originalFingerprint = await mainFingerprint();
    const headers = {
      "X-OpenDirector-Request": "1",
      "Content-Type": "image/png",
    };
    const uploaded = [];
    for (const [i, content] of fixture.uploads.entries()) {
      const name = `auxiliary-${fixture.id}-${i}.png`;
      const response = await page.request.post(
        base + "/api/library/items/upload?name=" + encodeURIComponent(name),
        { headers, data: Buffer.from(content, "base64") },
      );
      assert.equal(response.status(), 200);
      uploaded.push(await response.json());
    }
    const wrongName = `wrong-${fixture.id}.mp4`;
    const response = await page.request.post(
      base + "/api/library/items/upload?name=" + encodeURIComponent(wrongName),
      { headers: { ...headers, "Content-Type": "video/mp4" }, data: video },
    );
    assert.equal(response.status(), 200);
    const picker = page.getByRole("dialog", { name: "导入主体", exact: true });
    for (const [i, item] of uploaded.entries()) {
      await target
        .getByRole("button", { name: "添加附加图片", exact: true })
        .click();
      await picker.waitFor();
      assert.equal(
        await picker
          .getByRole("button", { name: "本地添加", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await picker
          .getByRole("checkbox", { name: `选择：${wrongName}`, exact: true })
          .isDisabled(),
        true,
      );
      await picker
        .getByRole("checkbox", { name: `选择：${item.name}`, exact: true })
        .click();
      await picker.getByRole("button", { name: "确定", exact: true }).click();
      await picker.waitFor({ state: "hidden" });
      await page.waitForFunction(
        ({ id, count }) =>
          document.querySelectorAll(
            `.react-flow__node[data-id="${id}"] .cw-subject-auxiliary img`,
          ).length === count,
        { id: fixture.images[0], count: i + 1 },
      );
      assert.equal(
        await target.locator(".cw-subject-main img").getAttribute("src"),
        mainBefore,
      );
    }
    assert.equal(
      await target
        .getByRole("button", { name: "添加附加图片", exact: true })
        .count(),
      0,
    );
    let storedCount = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await page.request.get(
        base + `/api/${"creation/projects/" + fixture.id}`,
        { headers: { "X-OpenDirector-Request": "1" } },
      );
      assert.equal(response.status(), 200);
      const saved = await response.json();
      {
        const item = saved.canvasItems.find(
          (item) => item.id === fixture.images[0],
        );
        storedCount = saved.editorDocuments.find(
          (doc) => doc.id === item.binding.objectRef.id,
        ).data.auxiliaries.length;
      }
      if (storedCount === 3) break;
      await page.waitForTimeout(100);
    }
    assert.equal(
      storedCount,
      3,
      "Auxiliary images must be persisted before reopening",
    );
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.waitForFunction(
      (id) =>
        document.querySelectorAll(
          `.react-flow__node[data-id="${id}"] .cw-subject-auxiliary img`,
        ).length === 3,
      fixture.images[0],
    );
    assert.equal(await target.locator(".cw-subject-auxiliary img").count(), 3);
    assert.equal(await mainFingerprint(), originalFingerprint);
    const film = node(fixture.video),
      player = film.locator("video");
    await film
      .getByRole("button", { name: "播放主体视频", exact: true })
      .click();
    await page.waitForFunction(
      (id) =>
        !document.querySelector(`.react-flow__node[data-id="${id}"] video`)
          .paused,
      fixture.video,
    );
    assert.equal(await player.evaluate((el) => el.controls), true);
    await player.evaluate((el) => el.pause());
    await film
      .getByRole("button", { name: "播放主体视频", exact: true })
      .waitFor();
    console.log(
      JSON.stringify({
        mode: "unified",
        auxiliaryStates: [0, 1, 2, 3],
        emptySlotFillsRail: true,
        primaryPreserved: true,
        invalidVideoRejected: true,
        reload: true,
        manualVideoPlayback: true,
      }),
    );
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, pageErrors: errors }));
} catch (error) {
  await page.screenshot({
    path: "/tmp/opendirector-subject-media-failure.png",
  });
  throw error;
} finally {
  await browser.close();
}
