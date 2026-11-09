/** Isolated API + Vite: light palettes cover real portals and editor panels. */
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
  "5",
  "-c:v",
  "libx264",
  // Avoid B-frame composition offsets: the fixture must seek exactly to 0s.
  "-bf",
  "0",
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
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1700, height: 1100 },
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
  await page.addInitScript(() => {
    if (!localStorage.getItem("opendirector.theme.v1"))
      localStorage.setItem("opendirector.theme.v1", "light");
  });
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base);
  const fixture = await page.evaluate(async (video) => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const { request, json } = await import("/src/backend/api.ts");
    const config = await request(
      "/model-configs",
      json("POST", {
        kind: "video",
        modelId: "FastH3-theme-fixture",
        url: "http://127.0.0.1:12345/v1",
        apiKey: "",
        connectionType: "self_hosted",
        protocol: "vllm_omni",
        authMode: "none",
        videoAdapter: "fasth3",
      }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ddaa44";
    ctx.fillRect(0, 0, 64, 64);
    const image = {
      ...createNode(
        "image",
        { x: 120, y: 130 },
        {
          title: "Theme image",
          src: canvas.toDataURL(),
          mediaRole: "asset",
          media: { width: 64, height: 64 },
        },
      ),
      width: 200,
      height: 200,
    };
    const clip = {
      ...createNode(
        "video",
        { x: 420, y: 130 },
        {
          title: "Theme video",
          src: "data:video/mp4;base64," + video,
          mediaRole: "asset",
          media: { width: 96, height: 64, durationSeconds: 5 },
        },
      ),
      width: 240,
      height: 160,
    };
    const target = {
      ...createNode(
        "video",
        { x: 800, y: 130 },
        {
          title: "Theme generator",
          prompt: "保持镜头，只替换人物。",
          settings: {
            mode: "video",
            model: config.modelId,
            modelConfigId: config.id,
            aspectRatio: "16:9",
            resolution: "480P",
            durationSeconds: 5,
            videoMode: "reference",
            prompt: "",
            count: 1,
          },
        },
      ),
      width: 240,
      height: 160,
    };
    const timeline = {
      ...createNode(
        "timeline",
        { x: 120, y: 500 },
        { title: "Theme timeline" },
      ),
      width: 240,
      height: 160,
    };
    const subject = {
      ...createNode(
        "subject",
        { x: 450, y: 500 },
        {
          title: "Theme subject",
          subject: {
            description: "Actor",
            category: "角色",
            auxiliaries: [],
            main: {
              id: crypto.randomUUID(),
              kind: "image",
              title: "Actor",
              src: canvas.toDataURL(),
              mimeType: "image/png",
            },
          },
        },
      ),
      width: 200,
      height: 160,
    };
    const saved = await importWorkspaceDocument({
      ...createDocument("Control theme " + crypto.randomUUID().slice(0, 8)),
      nodes: [image, clip, target, timeline, subject],
      edges: [image, clip].map((source) => ({
        id: crypto.randomUUID(),
        source: source.id,
        target: target.id,
        intent: "generation_input",
      })),
    });
    await releaseBackendProject();
    return {
      id: saved.id,
      image: image.id,
      video: clip.id,
      target: target.id,
      timeline: timeline.id,
      subject: subject.id,
    };
  }, video);
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(await page.title(), "OpenDirector · 创作画布");
  await page.getByRole("img", { name: "OpenDirector", exact: true }).waitFor();
  const checked = [];
  const color = async (locator, prop = "backgroundColor") =>
    locator.evaluate((el, prop) => getComputedStyle(el)[prop], prop);
  const channels = (value) =>
    value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  async function light(selector, label) {
    const element =
      typeof selector === "string" ? page.locator(selector).first() : selector;
    await element.waitFor({ state: "visible" });
    const bg = await color(element);
    assert.ok(
      channels(bg).every((n) => n >= 220),
      `${label}: ${bg}`,
    );
    checked.push(label);
    return element;
  }
  async function lightActionDock(label) {
    const dock = await light(".cw-node-action-dock", `${label} outer surface`);
    assert.equal(
      await color(dock, "borderTopColor"),
      "rgb(213, 226, 245)",
      `${label}: outer border must follow the light palette`,
    );
    return dock;
  }
  async function playback(theme) {
    const slider = page.getByRole("slider", {
      name: "视频播放位置",
      exact: true,
    });
    await slider.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector(".cw-va-transport input")?.disabled,
    );
    assert.equal(await color(slider, "appearance"), "none");
    assert.equal(await color(slider, "height"), "24px");
    const primary = page.locator(".cw-va-primary");
    assert.equal(
      await color(primary),
      theme === "light" ? "rgb(61, 107, 214)" : "rgb(167, 139, 212)",
    );
    const box = await slider.boundingBox();
    await slider.click({ position: { x: box.width * 0.6, y: box.height / 2 } });
    const fraction = await slider.evaluate(
      (el) => Number(el.value) / Number(el.max),
    );
    assert.ok(Math.abs(fraction - 0.6) < 0.04, `Seek click: ${fraction}`);
    const progress = () =>
      slider.evaluate((el) =>
        parseFloat(el.style.getPropertyValue("--control-progress")),
      );
    assert.ok(Math.abs((await progress()) - fraction * 100) < 0.1);
    await slider.press("Home");
    await page.waitForFunction(
      () => document.querySelector(".cw-va-transport input")?.value === "0",
    );
    assert.equal(await slider.inputValue(), "0");
    await slider.press("ArrowRight");
    assert.ok(Number(await slider.inputValue()) > 0);
    assert.equal(await color(slider, "outlineStyle"), "solid");
    await slider.press("Home");
    await page.getByRole("button", { name: "播放预览", exact: true }).click();
    await page.waitForFunction(
      () =>
        Number(document.querySelector(".cw-va-transport input")?.value) > 0.2,
    );
    await page.getByRole("button", { name: "暂停预览", exact: true }).click();
    assert.ok((await progress()) > 0, "Playback must update the filled track");
    await slider.press("End");
    assert.ok((await progress()) > 99);
    await slider.press("Home");
  }
  const select = async (id) => {
    // Editors can restore a zoomed viewport; fit before selecting distant nodes.
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+Digit1");
    await page
      .locator(`.react-flow__node[data-id="${id}"]`)
      .click({ position: { x: 5, y: 5 } });
  };
  const toolbar = page.getByRole("toolbar", { name: "节点操作", exact: true });
  await select(fixture.target);
  await light(".cw-composer", "generator composer");
  await page.getByRole("button", { name: "生成参数", exact: true }).click();
  const parameters = await light(
    ".cw-parameters-popover",
    "portaled generation parameters",
  );
  const ratio = parameters.getByRole("button", { name: "16:9", exact: true });
  assert.equal(await color(ratio), "rgb(227, 238, 255)");
  assert.equal(await color(ratio, "color"), "rgb(36, 86, 185)");
  await ratio.hover();
  assert.equal(await color(ratio), "rgb(227, 238, 255)");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/parameters-light.png`,
    });
  await parameters.press("Escape");
  await page.getByRole("button", { name: "视频生成时长", exact: true }).click();
  const duration = await light(
    ".cw-duration-popover",
    "portaled duration picker",
  );
  await light(duration.getByRole("spinbutton"), "duration input");
  const slider = duration.getByRole("slider");
  const trackAccent = await slider.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--cw-control-accent").trim(),
  );
  assert.equal(trackAccent, "#3d6bd6");
  await slider.press("End");
  await light(".cw-duration-notice", "duration boundary hint");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/duration-light.png`,
    });
  await duration.press("Escape");
  await page
    .getByRole("button", { name: "引用已连接节点", exact: true })
    .click();
  await light(".cw-reference-mention-picker", "reference picker");
  await page.keyboard.press("Escape");
  await select(fixture.image);
  await toolbar.getByRole("button", { name: "工具", exact: true }).click();
  const tools = await light(".cw-selection-menu", "image tool menu");
  await tools.press("Escape");
  await toolbar.getByRole("button", { name: "扩图", exact: true }).click();
  await light(".image-action-editor", "image action editor");
  await lightActionDock("image editor");
  await light(".image-action-editor .iae-footer", "image action footer");
  const imagePrimary = page.locator(".image-action-editor .iae-generate");
  assert.equal(await color(imagePrimary), "rgb(61, 107, 214)");
  assert.equal(await color(imagePrimary, "color"), "rgb(255, 255, 255)");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/image-editor-light.png`,
    });
  await page.getByRole("button", { name: "关闭编辑", exact: true }).click();
  await select(fixture.video);
  await toolbar.getByRole("button", { name: "视频编辑", exact: true }).click();
  await light(".cw-video-action-editor", "video action editor");
  await lightActionDock("video editor");
  await light(".cw-va-prompt textarea", "video prompt field");
  await playback("light");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/video-editor-light.png`,
    });
  await page.getByRole("button", { name: "关闭视频编辑", exact: true }).click();
  for (const [label, title] of [
    ["智能超清", "视频超清"],
    ["时长修剪", "时长修剪"],
  ]) {
    await select(fixture.video);
    await toolbar.getByRole("button", { name: label, exact: true }).click();
    await light(".cw-video-action-editor", label);
    await lightActionDock(label);
    await page
      .getByRole("button", { name: `关闭${title}`, exact: true })
      .click();
  }
  await select(fixture.timeline);
  await toolbar
    .getByRole("button", { name: "编辑时间线", exact: true })
    .click();
  const timeline = await light(".cw-timeline-dialog", "timeline dialog");
  assert.equal(
    await color(
      timeline.getByRole("slider", { name: "时间线播放位置" }),
      "appearance",
    ),
    "none",
  );
  await light(".cw-timeline-inspector", "timeline inspector");
  await light(".cw-timeline-tracks", "timeline tracks");
  await timeline
    .getByRole("button", { name: "关闭编辑器", exact: true })
    .click();
  await select(fixture.subject);
  // Subjects now edit directly on their canvas card, without a dialog.
  await light(".cw-domain-card-subject", "subject card");
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await light(".cw-lib-dialog", "asset library");
  await page.getByRole("button", { name: "关闭资产库", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = await light(".cw-settings-dialog", "settings dialog");
  await settings.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await select(fixture.target);
  await page.getByRole("button", { name: "生成参数", exact: true }).click();
  assert.equal(
    await color(parameters),
    "rgb(43, 44, 50)",
    "Dark palette must be restored on theme switch",
  );
  await parameters.press("Escape");
  await select(fixture.video);
  await toolbar.getByRole("button", { name: "智能超清", exact: true }).click();
  const darkDock = page.locator(".cw-node-action-dock");
  await darkDock.waitFor({ state: "visible" });
  assert.equal(await color(darkDock), "rgb(30, 32, 40)");
  assert.equal(
    await color(darkDock, "borderTopColor"),
    "rgba(255, 255, 255, 0.125)",
  );
  await playback("dark");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/video-upscale-dark.png`,
    });
  await page.getByRole("button", { name: "关闭视频超清", exact: true }).click();
  await select(fixture.video);
  await toolbar.getByRole("button", { name: "时长修剪", exact: true }).click();
  const trim = page.locator(".cw-va-range-fill");
  await trim.waitFor({ state: "visible" });
  assert.equal(await color(trim, "borderTopColor"), "rgb(167, 139, 212)");
  if (process.env.THEME_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.THEME_SCREENSHOT_DIR}/video-trim-dark.png`,
    });
  await page.getByRole("button", { name: "关闭时长修剪", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.deepEqual(errors, []);
  const final = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(final.calls.length, health.calls.length);
  console.log(
    JSON.stringify({
      isolated: true,
      lightPanels: checked,
      blueSelectedControls: true,
      themedPlaybackSeekingAndProgress: true,
      darkThemeRestored: true,
      persistedTheme: true,
      noGenerationSubmitted: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
