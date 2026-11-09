import { chooseGenerationModel } from "./model_picker.mjs";
/** Saved parameters and real PNG mask -> fixed tool input -> editable output. */
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
assert.equal((await call("/api/creation-test-health")).isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: "Tool draft " + projectId.slice(0, 8) },
});
const state = () => call(`/api/creation/projects/${projectId}`);
const tasks = async () =>
  (await call(`/api/creation/projects/${projectId}/tool-tasks`)).tasks;
async function until(read, predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + label);
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
const prompt = () => page.getByPlaceholder("描述希望怎样修改这张图片");
async function open(id) {
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  const rect = await node.boundingBox();
  await node.click({ position: { x: rect.width * 0.4, y: rect.height * 0.4 } });
  await page.getByRole("button", { name: "智能改图", exact: true }).click();
  await prompt().waitFor();
}
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await saved();
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加图片", exact: true })
    .click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  await page
    .getByRole("textbox", { name: "生成提示词", exact: true })
    .fill("Source pixels for selection");
  await page.getByRole("button", { name: "提交生成", exact: true }).click();
  let snapshot = await until(
    state,
    (s) => s.jobs[0]?.status === "succeeded",
    "source generation",
  );
  const source = snapshot.canvasItems[0];
  await page.waitForFunction((id) => {
    const img = document.querySelector(
      `.react-flow__node[data-id="${id}"] img.cw-image-preview`,
    );
    return img?.complete && img.naturalWidth === 320;
  }, source.id);
  await saved();
  await open(source.id);
  await prompt().fill("Make the selected region green");
  await page.getByRole("button", { name: "局部选区", exact: true }).click();
  const drawing = page.locator("canvas.iae-ink-mask");
  await drawing.waitFor();
  const rect = await drawing.boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height * 0.6, {
    steps: 12,
  });
  await page.mouse.up();
  snapshot = await until(
    state,
    (s) =>
      s.editorDocuments.some(
        (d) => d.kind === "media_edit" && d.data.selection?.mask,
      ),
    "saved mask",
  );
  const draft = snapshot.editorDocuments.find((d) => d.kind === "media_edit");
  assert.equal(draft.data.parameters.prompt, "Make the selected region green");
  assert.deepEqual(draft.data.sourceItems, [source.id]);
  assert.deepEqual(
    [draft.data.selection.width, draft.data.selection.height],
    [320, 240],
  );
  const maskId = draft.data.selection.mask.assetId;
  const maskPixels = await page.evaluate(
    async ({ projectId, maskId }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const src = await creationClient(projectId).mediaUrl(maskId);
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      return {
        width: img.width,
        height: img.height,
        selected: Array.from(pixels).filter((v, i) => i % 4 === 0 && v > 128)
          .length,
      };
    },
    { projectId, maskId },
  );
  assert.equal(maskPixels.width, 320);
  assert.equal(maskPixels.height, 240);
  assert.ok(maskPixels.selected > 0 && maskPixels.selected < 320 * 240);
  await page.getByRole("button", { name: "关闭编辑", exact: true }).click();
  await saved();
  await page.reload();
  await saved();
  await open(source.id);
  assert.equal(await prompt().inputValue(), "Make the selected region green");
  await page
    .getByRole("button", { name: "局部选区 · 已选", exact: true })
    .waitFor();
  await page.locator(".iae-generate").click();
  const accepted = (
    await until(
      tasks,
      (rows) => rows.length === 1 && rows[0].status === "succeeded",
      "tool result",
    )
  )[0];
  assert.equal(accepted.draftSnapshot.data.selection.mask.assetId, maskId);
  assert.deepEqual(
    accepted.sourceAssetIds,
    draft.data.sources.map((r) => r.assetId),
  );
  await until(
    tasks,
    (rows) => rows[0].placement === "placed",
    "automatic adoption",
  );
  snapshot = await state();
  assert.equal(
    snapshot.jobs.length,
    1,
    "tools do not fabricate generation jobs",
  );
  assert.equal(
    snapshot.references.length,
    0,
    "tool provenance is not generation reference",
  );
  const output = accepted.outputs[0];
  const asset = snapshot.assets.find((a) => a.id === output.id);
  assert.equal(asset.provenance.toolTaskId, accepted.id);
  assert.ok(asset.provenance.sources.some((r) => r.assetId === maskId));
  await page.reload();
  await saved();
  await open(output.canvasItemId);
  assert.equal(await prompt().inputValue(), "Make the selected region green");
  await page.getByRole("button", { name: "局部选区", exact: true }).waitFor();
  await prompt().fill("Continue editing the actual output");
  await page.getByRole("button", { name: "关闭编辑", exact: true }).click();
  await saved();
  snapshot = await until(
    state,
    (s) =>
      s.editorDocuments.some(
        (d) =>
          d.kind === "media_edit" &&
          d.data.parameters.prompt === "Continue editing the actual output",
      ),
    "continued draft",
  );
  const next = snapshot.editorDocuments.find(
    (d) =>
      d.kind === "media_edit" && d.data.sourceItems[0] === output.canvasItemId,
  );
  assert.equal(next.data.sources[0].assetId, output.id);
  assert.equal(next.data.selection?.mask ?? null, null);
  assert.equal(
    (await tasks())[0].draftSnapshot.data.parameters.prompt,
    "Make the selected region green",
  );
  await page.reload();
  await saved();
  await open(output.canvasItemId);
  assert.equal(
    await prompt().inputValue(),
    "Continue editing the actual output",
  );
  // Lose both acceptance and immediate lookup; reload and explicitly retry.
  // The browser must resend the original intent, not create another paid task.
  const sent = [];
  let lookupLost = false;
  const path = `**/creation/projects/${projectId}/tool-tasks`;
  const lookupPath = path + "/*";
  await page.route(path, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.route(lookupPath, async (route) => {
    if (route.request().method() === "GET") {
      lookupLost = true;
      await route.abort("failed");
    } else await route.continue();
  });
  // The continued draft keeps selection mode and no mask, which disables
  // generate. Mark mode is the whole-image edit this retry is asserting.
  await page
    .locator(".iae-segment")
    .getByRole("button", { name: "标记", exact: true })
    .click();
  await page.locator(".iae-generate").click();
  await until(async () => lookupLost, Boolean, "lost task lookup");
  await page.reload();
  await saved();
  await page.unroute(lookupPath);
  await until(
    tasks,
    (rows) =>
      rows.length === 2 && rows.every((row) => row.status === "succeeded"),
    "accepted original attempt",
  );
  await open(output.canvasItemId);
  await prompt().fill("New edits must not replace the unknown request");
  await page
    .locator(".iae-segment")
    .getByRole("button", { name: "标记", exact: true })
    .click();
  await page.locator(".iae-generate").click();
  await until(
    async () => sent.length,
    (count) => count === 2,
    "original intent retry",
  );
  assert.deepEqual(sent[1], sent[0]);
  assert.equal((await tasks()).length, 2);
  await page.waitForFunction(
    () =>
      !Object.keys(sessionStorage).some((key) =>
        key.startsWith("opendirector.creation.tool-delivery:"),
      ),
  );
  await page.unroute(path);
  assert.deepEqual(errors, []);
  console.log(
    "PASS tool draft: real painted mask, saved parameters, reload, frozen input, source provenance, adopted output, independent continued editing and unknown submission replay after reload.",
  );
} finally {
  await browser.close();
}
