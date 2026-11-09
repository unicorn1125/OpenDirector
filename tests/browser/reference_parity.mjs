/** Isolated fixture only: real structured submission, source choices and upload rejection. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5187";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==";
const bootstrap = (url) =>
  url.origin === new URL(base).origin && url.pathname === "/";
try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true);
  await page.route(bootstrap, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto(base);
  const submission = await page.evaluate(async (png) => {
    const { request } = await import("/src/backend/api.ts");
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const { uploadReferenceFile } =
      await import("/src/backend/referenceUploads.ts");
    const { generationContentPatch } =
      await import("/src/canvas/generationReferenceContent.ts");
    const config = (await request("/model-configs")).find(
      (m) => m.kind === "image",
    );
    const sources = [0, 1].map((i) =>
      createNode(
        "image",
        { x: i * 400, y: 100 },
        {
          title: "same name",
          src: png,
          mimeType: "image/png",
          mediaRole: "asset",
          assetState: "ready",
        },
      ),
    );
    const target = createNode(
      "image",
      { x: 800, y: 100 },
      {
        title: "Target",
        prompt: "Draw",
        settings: {
          mode: "image",
          model: config.modelId,
          modelConfigId: config.id,
          aspectRatio: "1:1",
          resolution: "1024",
          count: 1,
          prompt: "",
        },
      },
    );
    const part = (node) => ({
      type: "reference",
      assetId: "node:" + node.id,
      nodeId: node.id,
      name: node.data.title,
    });
    Object.assign(
      target.data,
      generationContentPatch(
        [
          { type: "text", text: "Before " },
          part(sources[1]),
          { type: "text", text: " between " },
          part(sources[0]),
          { type: "text", text: " repeat " },
          part(sources[1]),
        ],
      ),
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("Parity " + crypto.randomUUID().slice(0, 8)),
      nodes: [...sources, target],
      edges: sources.map((n) => ({
        id: crypto.randomUUID(),
        source: n.id,
        target: target.id,
      })),
    });
    const client = creationClient(saved.id);
    const run = async () => {
      const receipt = await client.submit(target.id, "candidate_only");
      for (let i = 0; i < 150; i++) {
        await client.refresh();
        const job = client.snapshot.jobs.find(
          (j) => j.id === receipt.jobIds[0],
        );
        if (job && ["succeeded", "failed"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Fixture did not complete");
    };
    const first = await run(),
      second = await run();
    const refs = client.snapshot.references.filter((r) => r.active);
    const expectedOrder = [sources[1], sources[0], sources[1]].map(
      (n) => refs.find((r) => r.source.id === n.id)?.id,
    );
    const file = new File([await (await fetch(png)).blob()], "same.png", {
      type: "image/png",
    });
    let choiceCount = 0,
      cancelled = false;
    const chosen = await uploadReferenceFile(
      saved.id,
      file,
      new AbortController().signal,
      async (matches) => {
        choiceCount = matches.length;
        return matches.find((a) => a.nodeId === sources[1].id);
      },
    );
    const before = client.snapshot.assets.length;
    try {
      await uploadReferenceFile(
        saved.id,
        file,
        new AbortController().signal,
        async () => {
          throw new DOMException("cancel", "AbortError");
        },
      );
    } catch (e) {
      cancelled = e.name === "AbortError";
    }
    await client.refresh();
    const output = {
      firstStatus: first.status,
      secondStatus: second.status,
      firstInputs: first.inputSnapshot.references,
      secondInputs: second.inputSnapshot.references,
      order: second.inputSnapshot.spec.promptContent
        .filter((p) => p.type === "reference")
        .map((p) => p.referenceId),
      expectedOrder,
      choiceCount,
      chosen: chosen.nodeId,
      expectedChoice: sources[1].id,
      cancelled,
      unchanged: before === client.snapshot.assets.length,
    };
    client.close();
    await releaseBackendProject();
    return output;
  }, png);
  assert.equal(submission.firstStatus, "succeeded");
  assert.equal(submission.secondStatus, "succeeded");
  assert.deepEqual(submission.firstInputs, submission.secondInputs);
  assert.deepEqual(submission.order, submission.expectedOrder);
  assert.equal(submission.choiceCount, 2);
  assert.equal(submission.chosen, submission.expectedChoice);
  assert.equal(submission.cancelled, true);
  assert.equal(submission.unchanged, true);
  console.log(
    "PASS default entry: frozen reference identities, inline order/repeats, equal-content source choice and cancellation",
  );

  const mp4 = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:r=5",
    "-t",
    "1",
    "-threads",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ]);
  {
    const unified = true;
    await page.goto(base + "/");
    const fixture = await page.evaluate(async () => {
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const node = createNode(
        "image",
        { x: 100, y: 100 },
        { title: "Type protected" },
      );
      const saved = await importWorkspaceDocument({
        ...createDocument(),
        title: "Parity type " + crypto.randomUUID().slice(0, 8),
        nodes: [node],
        edges: [],
      });
      await releaseBackendProject();
      return { id: saved.id, node: node.id };
    });
    await page.unroute(bootstrap);
    await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}${""}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const card = page.locator(`.react-flow__node[data-id="${fixture.node}"]`);
    await card.hover();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      card.getByRole("button", { name: "上传图片", exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: "wrong.mp4",
      mimeType: "video/mp4",
      buffer: mp4,
    });
    await page.getByText(/该节点仅支持图片素材/).waitFor();
    assert.equal(
      await page
        .locator(`.react-flow__node[data-id="${fixture.node}"] video`)
        .count(),
      0,
    );
    assert.equal(
      await card.getByRole("button", { name: "上传图片", exact: true }).count(),
      1,
    );
    await card.click();
    await page
      .getByRole("textbox", { name: "生成提示词", exact: true })
      .waitFor();
    await page.locator(".cw-composer input[type=file]").setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("结构化文本参考", "utf8"),
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cw-composer [data-reference]").length === 1,
    );
    const part = JSON.parse(
      await page
        .locator(".cw-composer [data-reference]")
        .getAttribute("data-reference"),
    );
    assert.ok(part.nodeId);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const fixed = await page.evaluate(
      async ({ projectId, nodeId }) => {
        const { loadReferenceCatalog } =
          await import("/src/backend/referenceCatalog.ts");
        const asset = (await loadReferenceCatalog(projectId)).find(
          (asset) => asset.nodeId === nodeId,
        );
        if (!asset)
          throw new Error("Uploaded source missing from canonical catalog");
        return {
          type: "reference",
          binding: "asset",
          assetId: asset.id,
          nodeId: asset.nodeId,
          name: asset.name,
          fingerprint: asset.fingerprint,
        };
      },
      { projectId: fixture.id, nodeId: part.nodeId },
    );
    await page
      .getByRole("textbox", { name: "生成提示词", exact: true })
      .fill("");
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "生成提示词", exact: true })
      .evaluate(
        (element, payload) => {
          const clipboard = new DataTransfer();
          clipboard.setData(
            "application/x-opendirector-references",
            JSON.stringify(payload),
          );
          clipboard.setData("text/plain", "@Pinned");
          element.focus();
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          );
        },
        { scope: fixture.id, content: [fixed] },
      );
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cw-composer [data-reference]").length === 1,
    );
    const pasted = JSON.parse(
      await page
        .locator(".cw-composer [data-reference]")
        .getAttribute("data-reference"),
    );
    assert.equal(pasted.binding, "asset");
    assert.equal(pasted.nodeId, undefined);
    assert.equal(await page.locator(".react-flow__edge").count(), 0);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    console.log(
      `PASS ${"unified"}: actual MP4 rejected by empty image node; UTF-8 Markdown reference linked; pinned paste loads inventory without opening @ and creates no following edge.`,
    );
    await page.evaluate(async () => {
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
    });
    await page.route(bootstrap, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body></body></html>",
      }),
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({
    path: "/tmp/opendirector-reference-parity-failure.png",
  });
  console.error((await page.locator("body").innerText()).slice(-1600));
  throw error;
} finally {
  await browser.close();
}
