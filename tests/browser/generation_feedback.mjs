import { chooseGenerationModel } from "./model_picker.mjs";
/** Isolated model double + real project storage. Deliberately stalled network reads. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
async function call(path, body) {
  const response = await fetch(api + path, {
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Expected feedback or persisted task state not observed");
}
function gate() {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const config = await call("/api/model-configs", {
  kind: "video",
  modelId: `feedback-video-${crypto.randomUUID()}`,
  url: "http://127.0.0.1:12345/v1",
  apiKey: "",
  connectionType: "self_hosted",
  protocol: "vllm_omni",
  authMode: "none",
  videoAdapter: "standard",
  videoCapabilities: {
    outputs: [{ resolution: "480P", width: 832, height: 480, durations: [5] }],
    defaultResolution: "480P",
    defaultDuration: 5,
    dimensionStep: 2,
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const errors = [];
async function setup(kind = "image") {
  await call("/api/creation-test-gate", { open: false });
  const id = crypto.randomUUID();
  await call(`/api/creation/projects/${id}/commands`, {
    projectId: id,
    commandId: crypto.randomUUID(),
    type: "project.create",
    payload: { name: `Feedback ${id.slice(0, 8)}` },
  });
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  const state = () => call(`/api/creation/projects/${id}`);
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", {
      name: kind === "video" ? "添加视频" : "添加图片",
      exact: true,
    })
    .click();
  await chooseGenerationModel(page, kind === "video" ? `config:${config.id}` : { label: "fixture-image" });
  await page
    .getByRole("textbox", { name: "生成提示词", exact: true })
    .fill("Feedback probe");
  await until(async () => {
    const s = await state();
    return (
      s.generationSpecs[0]?.prompt === "Feedback probe" &&
      s.generationSpecs[0]?.modelConfigId
    );
  });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  return {
    page,
    id,
    state,
    submit: page.getByRole("button", { name: "提交生成", exact: true }),
    cancel: page.getByRole("button", { name: "取消生成", exact: true }),
    overlay: page.locator(".cw-generating"),
  };
}
try {
  if (!process.argv.includes("--tools-only")) {
    // Pending submission is visible immediately and prevents repeated intent.
    {
      const { page, state, submit, cancel, overlay } = await setup("video");
      const hold = gate();
      let submissions = 0;
      await page.route("**/commands", async (route) => {
        if (route.request().postDataJSON()?.type === "generation.submit") {
          submissions++;
          await hold.wait;
        }
        await route.continue();
      });
      await submit.evaluate((button) => {
        button.click();
        button.click();
      });
      await until(() => submissions === 1);
      await overlay.waitFor();
      assert.equal(await overlay.getAttribute("data-phase"), "submitting");
      assert.equal(await submit.count(), 0);
      assert.ok(await cancel.isVisible());
      const dock = page.locator(".cw-composer-dock").filter({ has: cancel });
      const locked = await dock.evaluate((element) => {
        const prompt = element.querySelector(".cw-prompt-input");
        const root = document.documentElement;
        const theme = root.getAttribute("data-theme");
        root.dataset.theme = "dark";
        const dark = getComputedStyle(prompt).color;
        root.dataset.theme = "light";
        const light = getComputedStyle(prompt).color;
        if (theme === null) root.removeAttribute("data-theme");
        else root.dataset.theme = theme;
        return {
          editable: prompt.getAttribute("contenteditable"),
          dark,
          light,
          enabled: [...element.querySelectorAll("button:enabled")]
            .filter((button) => button.getClientRects().length)
            .map((button) => button.getAttribute("aria-label")),
        };
      });
      assert.equal(locked.editable, "false");
      assert.equal(locked.dark, "rgb(125, 130, 145)");
      assert.equal(locked.light, "rgb(123, 130, 144)");
      assert.deepEqual(locked.enabled, ["取消生成"]);
      assert.equal((await state()).jobs.length, 0);
      hold.release();
      await until(async () => (await state()).jobs.length === 1);
      await page.waitForTimeout(300);
      let snapshot = await state();
      assert.equal(snapshot.jobs.length, 1);
      assert.equal(submissions, 1);
      assert.equal(
        snapshot.generationSpecs[0].parameters.videoMode,
        "reference",
      );
      assert.equal(
        snapshot.jobs[0].inputSnapshot.spec.parameters.videoMode,
        "first_frame",
      );
      await call("/api/creation-test-gate", { open: true });
      await until(async () => (await state()).jobs[0]?.status === "succeeded");
      await overlay.waitFor({ state: "hidden" });
      snapshot = await state();
      assert.equal(snapshot.jobs[0].adopted, true);
      assert.ok(snapshot.generationSpecs[0].currentResultId);
      const result = snapshot.results[0];
      assert.ok(result);
      assert.ok(
        snapshot.assets.find((a) => a.id === result.asset.assetId).metadata
          .size > 0,
      );
      await page.reload();
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      assert.equal((await state()).jobs.length, 1);
      assert.equal(await overlay.count(), 0);
      await page.close();
      console.log(
        "PASS video: immediate feedback, double click, effective mode, result and reload",
      );
    }
    // Accepted jobs and their terminal status do not wait for unrelated tool reads.
    {
      const { page, state, submit, cancel, overlay } = await setup();
      const hold = gate();
      let blocked = 0;
      await page.route("**/tool-tasks", async (route) => {
        blocked++;
        await hold.wait;
        await route.continue();
      });
      await submit.click();
      await until(async () => (await state()).jobs.length === 1);
      await until(() => blocked > 0);
      await overlay.waitFor();
      assert.ok(await cancel.isVisible());
      await cancel.click();
      await until(async () => (await state()).jobs[0]?.status === "cancelled");
      await overlay.waitFor({ state: "hidden" });
      assert.ok(await submit.isEnabled());
      hold.release();
      await page.close();
      console.log(
        "PASS image: stalled tool history cannot block accepted/cancelled status",
      );
    }
    // Cancel during delivery waits for that receipt and cancels the original job.
    {
      const { page, state, submit, cancel, overlay } = await setup();
      const hold = gate();
      let sent = 0;
      await page.route("**/commands", async (route) => {
        if (route.request().postDataJSON()?.type === "generation.submit") {
          sent++;
          await hold.wait;
        }
        await route.continue();
      });
      await submit.click();
      await until(() => sent === 1);
      await cancel.click();
      hold.release();
      await until(async () => (await state()).jobs[0]?.status === "cancelled");
      await overlay.waitFor({ state: "hidden" });
      assert.equal((await state()).jobs.length, 1);
      assert.equal(sent, 1);
      await page.close();
      console.log(
        "PASS cancel during delivery: original accepted task cancelled",
      );
    }
    // Saving happens under the preparing indicator; cancelling then sends no job.
    {
      const { page, state, submit, cancel, overlay } = await setup();
      const hold = gate();
      let saving = 0,
        sent = 0;
      await page.route("**/commands", async (route) => {
        const type = route.request().postDataJSON()?.type;
        if (type === "creation.batch") {
          saving++;
          await hold.wait;
        }
        if (type === "generation.submit") sent++;
        await route.continue();
      });
      await page
        .getByRole("textbox", { name: "生成提示词", exact: true })
        .fill("Changed before save");
      await submit.click();
      await until(() => saving > 0);
      await overlay.waitFor();
      assert.equal(await overlay.getAttribute("data-phase"), "preparing");
      await cancel.click();
      hold.release();
      await overlay.waitFor({ state: "hidden" });
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      assert.equal(sent, 0);
      assert.equal((await state()).jobs.length, 0);
      assert.ok(await submit.isEnabled());
      await page.close();
      console.log("PASS cancel while saving: no generation request");
    }
    // A definitive refusal clears transient activity and permits a new submission.
    {
      const { page, state, submit, overlay } = await setup();
      let reject = true;
      await page.route("**/commands", async (route) => {
        if (
          reject &&
          route.request().postDataJSON()?.type === "generation.submit"
        ) {
          await route.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Fixture refusal" }),
          });
          return;
        }
        await route.continue();
      });
      await submit.click();
      await page.getByText("Fixture refusal", { exact: false }).waitFor();
      await overlay.waitFor({ state: "hidden" });
      assert.equal((await state()).jobs.length, 0);
      reject = false;
      await submit.click();
      await until(async () => (await state()).jobs.length === 1);
      await overlay.waitFor();
      await page.close();
      console.log("PASS rejected submit: activity clears and retry works");
    }
    // Loading an older unselected result must not block a new task or its end.
    {
      const { page, id, state, submit, cancel, overlay } = await setup();
      await call("/api/creation-test-gate", { open: true });
      await submit.click();
      await until(async () => (await state()).jobs[0]?.status === "succeeded");
      await overlay.waitFor({ state: "hidden" });
      const oldAsset = (await state()).results[0].asset.assetId;
      await submit.click();
      await until(async () => {
        const s = await state();
        return (
          s.jobs.length === 2 && s.jobs.every((j) => j.status === "succeeded")
        );
      });
      await overlay.waitFor({ state: "hidden" });
      const hold = gate();
      let blocked = 0;
      await page.route(`**/assets/${oldAsset}/content`, async (route) => {
        blocked++;
        await hold.wait;
        await route.continue();
      });
      await page.reload();
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      await until(() => blocked > 0);
      await call("/api/creation-test-gate", { open: false });
      // Re-select after reload: selection is view state and need not be retained.
      await page.locator(".react-flow__node").first().click();
      await submit.click();
      await until(async () => (await state()).jobs.length === 3);
      await overlay.waitFor();
      assert.ok(await cancel.isVisible());
      await cancel.click();
      await until(async () =>
        (await state()).jobs.some((j) => j.status === "cancelled"),
      );
      await overlay.waitFor({ state: "hidden" });
      hold.release();
      await page.close();
      console.log(
        "PASS slow old media: new task activity and cancellation remain independent",
      );
    }
    // A lost HTTP reply recovers the original receipt, without another POST.
    {
      const { page, state, submit, overlay } = await setup();
      let submissions = 0;
      await page.route("**/commands", async (route) => {
        if (route.request().postDataJSON()?.type === "generation.submit") {
          submissions++;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      });
      await submit.click();
      await until(async () => (await state()).jobs.length === 1);
      await overlay.waitFor();
      await page.waitForTimeout(300);
      assert.equal(submissions, 1);
      await page.reload();
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      await overlay.waitFor();
      assert.equal((await state()).jobs.length, 1);
      await page.close();
      console.log(
        "PASS lost reply and reload: one original task remains active",
      );
    }
    // Explicit batches still submit their requested count under the UI guard.
    {
      const { page, state, submit, overlay } = await setup();
      await page.locator(".react-flow__node").first().click();
      await page.getByRole("button", { name: "生成参数", exact: true }).click();
      await page
        .locator(".cw-count-options")
        .getByRole("button", { name: "2", exact: true })
        .click();
      await page.getByRole("button", { name: "生成参数", exact: true }).click();
      await submit.click();
      await until(async () => (await state()).jobs.length === 2);
      const snapshot = await state();
      assert.ok(snapshot.jobs[0].batchId);
      assert.equal(snapshot.jobs[0].batchId, snapshot.jobs[1].batchId);
      assert.equal(new Set(snapshot.jobs.map((j) => j.id)).size, 2);
      await overlay.waitFor();
      await page.close();
      console.log("PASS explicit batch: two distinct jobs share one batch");
    }
  }
  // Tools also expose preparation before waiting for the placeholder/draft save.
  {
    const { page, id, state, submit, overlay } = await setup();
    await call("/api/creation-test-gate", { open: true });
    await submit.click();
    await until(async () => (await state()).jobs[0]?.status === "succeeded");
    await overlay.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "扩图", exact: true }).click();
    const editor = page.getByRole("region", {
      name: "扩图编辑器",
      exact: true,
    });
    await editor.waitFor();
    const hold = gate();
    let saves = 0,
      toolPosts = 0;
    await page.route("**/commands", async (route) => {
      if (route.request().postDataJSON()?.type === "creation.batch") {
        saves++;
        await hold.wait;
      }
      await route.continue();
    });
    await page.route("**/tool-tasks", async (route) => {
      if (route.request().method() === "POST") toolPosts++;
      await route.continue();
    });
    await editor.getByRole("button", { name: "生成", exact: true }).click();
    await until(() => saves > 0);
    await overlay.waitFor();
    assert.equal(await overlay.getAttribute("data-phase"), "preparing");
    assert.equal(toolPosts, 0);
    hold.release();
    await until(() => toolPosts === 1);
    await until(async () =>
      (await call(`/api/creation/projects/${id}/tool-tasks`)).tasks.some(
        (t) => t.status === "succeeded",
      ),
    );
    await overlay.waitFor({ state: "hidden" });
    assert.equal(toolPosts, 1);
    await page.close();
    console.log(
      "PASS tool: immediate preparation before draft save and one accepted task",
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await call("/api/creation-test-gate", { open: true });
  await browser.close();
}
