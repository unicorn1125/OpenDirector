/** Real UI and draft API; CLI readiness/model discovery are response fixtures. */
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
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const headers = { "X-OpenDirector-Request": "1" };
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", { headers })
      ).json()
    ).isolated,
    true,
  );
  let status = "needs_configuration";
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          label: "Default",
          group: "default",
          modelSource: "settings",
          available: true,
          status: "ready",
          modelOverride: false,
        },
        {
          id: "jiuwenswarm",
          label: "JiuwenSwarm",
          group: "harness",
          modelSource: "cli",
          available: true,
          status,
          modelOverride: true,
          supportsSkills: true,
        },
      ],
    }),
  );
  await page.route(/\/assistant\/runtimes\/jiuwenswarm\/status(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        id: "jiuwenswarm",
        label: "JiuwenSwarm",
        group: "harness",
        modelSource: "cli",
        available: true,
        status,
        modelOverride: true,
        supportsSkills: true,
      },
    }),
  );
  await page.route(/\/assistant\/runtimes\/jiuwenswarm\/models(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          id: "swarm-model#0",
          label: "Swarm Local",
          isDefault: true,
          efforts: [],
        },
        { id: "swarm-model#1", label: "Swarm Alternate", efforts: [] },
      ],
    }),
  );
  await page.goto(base);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.getByRole("button", { name: "与 AI 对话", exact: true }).click();
  const trigger = page.getByRole("button", { name: /^Agent：/ });
  await trigger.click();
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: "JiuwenSwarm" })
    .click();
  await page.getByRole("heading", { name: "配置 JiuwenSwarm" }).waitFor();
  await page.getByText("尚未配置模型", { exact: true }).waitFor();
  assert.ok(
    await page.getByText("jiuwenswarm-init", { exact: true }).isVisible(),
  );
  status = "ready";
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await page
    .getByRole("button", { name: "使用 JiuwenSwarm", exact: true })
    .click();
  await page.getByRole("button", { name: /^Agent：JiuwenSwarm/ }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "使用技能", exact: true })
      .isEnabled(),
    true,
  );
  const editor = page.getByRole("textbox", { name: "消息内容", exact: true });
  await editor.fill("/");
  await page.getByRole("dialog", { name: "使用技能", exact: true }).waitFor();
  await page
    .getByRole("option")
    .filter({ hasText: "character-replacement" })
    .click();
  await page
    .getByLabel("技能：character-replacement", { exact: true })
    .waitFor();
  assert.ok((await editor.getAttribute("data-placeholder")).includes("/"));
  await trigger.click();
  await page
    .getByRole("button", { name: "编辑 JiuwenSwarm 模型", exact: true })
    .click();
  assert.equal(await page.getByText("High", { exact: true }).count(), 0);
  await page
    .getByRole("menuitemradio", { name: "Swarm Alternate", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Agent：JiuwenSwarm · Swarm Alternate",
      exact: true,
    })
    .waitFor();
  const project = (
    await (
      await page.request.get(base + "/api/creation/projects", { headers })
    ).json()
  ).projects[0];
  const deadline = Date.now() + 10000;
  while (true) {
    const saved = await (
      await page.request.get(
        `${base}/api/creation/projects/${project.id}/assistant`,
        { headers },
      )
    ).json();
    if (
      saved.runtime === "jiuwenswarm" &&
      saved.harnessModels.jiuwenswarm === "swarm-model#1" &&
      saved.skills.includes("character-replacement")
    )
      break;
    assert.ok(Date.now() < deadline, "Runtime selection must be persisted");
    await page.waitForTimeout(100);
  }
  await page.reload();
  await page.getByRole("button", { name: "与 AI 对话", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Agent：JiuwenSwarm · Swarm Alternate",
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("技能：character-replacement", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      configurationGuide: true,
      modelSelection: true,
      skillSelectionEnabled: true,
      skillSelectionRestored: true,
      unsupportedEffortHidden: true,
      draftPersisted: true,
      selectionRestored: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
