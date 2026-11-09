/** Ordinary URL, project lifecycle, unsupported-format isolation, and no legacy UI writes. */
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
};
async function api(path, body) {
  const r = await fetch(base + "/api" + path, {
    headers: { ...headers, "Content-Type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(r.ok, await r.clone().text());
  return r.json();
}
const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
const initiallyEmpty = (await api("/creation/projects")).projects.length === 0;
// Seed a real old-format directory only in the isolated fixture, then check byte-for-byte preservation.
const old = await api("/creation-test-legacy-projects", {
  id: crypto.randomUUID(),
  name: initiallyEmpty
    ? "未命名画布"
    : "Old format " + crypto.randomUUID().slice(0, 8),
});
async function files(path) {
  const result = {};
  for (const ent of await readdir(path, { withFileTypes: true })) {
    const p = join(path, ent.name);
    if (ent.isDirectory()) Object.assign(result, await files(p));
    else if (ent.isFile()) result[p] = (await readFile(p)).toString("base64");
  }
  return result;
}
const before = await files(old.path);
const credentials = await readFile(
  join(health.root, ".opendirector", "models.json"),
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [],
  legacy = [];
const sessions = new Set();
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  const session = r.headers()["x-opendirector-session"];
  if (session) sessions.add(session);
  if (/^\/api\/(projects|data|sessions)(\/|$)/.test(new URL(r.url()).pathname))
    legacy.push(r.method() + " " + r.url());
});
const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
try {
  // A shared nightly server already has projects leased by earlier scripts.
  // Pin a project this page owns. An empty server still proves the legacy
  // directory is ignored and the default name is suffixed.
  let ownProjectId = null;
  if (!initiallyEmpty) {
    ownProjectId = crypto.randomUUID();
    await api(`/creation/projects/${ownProjectId}/commands`, {
      type: "project.create",
      projectId: ownProjectId,
      commandId: crypto.randomUUID(),
      payload: { name: "Default entry host " + ownProjectId.slice(0, 8) },
    });
  }
  await page.addInitScript(
    ({ legacyId, ownProjectId }) => {
      localStorage.setItem("opendirector.lastFilesystemProject", legacyId);
      // Only the first load is pinned. Later navigations keep the project the
      // app itself recorded, including the one created in this check.
      if (
        ownProjectId &&
        !localStorage.getItem("opendirector.lastUnifiedFilesystemProject")
      )
        localStorage.setItem(
          "opendirector.lastUnifiedFilesystemProject",
          ownProjectId,
        );
    },
    { legacyId: old.id, ownProjectId },
  );
  await page.goto(base + "/");
  await saved();
  assert.equal(new URL(page.url()).search, "");
  if (initiallyEmpty) {
    const first = (await api("/creation/projects")).projects;
    assert.equal(first.length, 1);
    assert.equal(first[0].name, "未命名画布 (2)");
  }
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByText(/使用旧格式/).waitFor();
  // The current project's check shares the trailing slot with its row actions
  // button, which covers it while the row is hovered.
  const currentRow = page
    .locator(".cw-project-row:has(.cw-project-check)")
    .first();
  const checkBox = await currentRow.locator(".cw-project-check").boundingBox();
  const moreBox = await currentRow.locator(".cw-project-more").boundingBox();
  assert.ok(checkBox && moreBox);
  assert.equal(Math.round(checkBox.x), Math.round(moreBox.x));
  assert.equal(Math.round(checkBox.width), Math.round(moreBox.width));
  await currentRow.hover();
  await page.waitForTimeout(250);
  assert.equal(
    await currentRow
      .locator(".cw-project-check")
      .evaluate((element) => getComputedStyle(element).opacity),
    "0",
  );
  assert.equal(
    await currentRow
      .locator(".cw-project-more")
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  assert.equal(
    await page.getByRole("menuitem", { name: old.name, exact: true }).count(),
    0,
  );
  const name = "Default entry " + crypto.randomUUID().slice(0, 8);
  // New canvas projects are created immediately, then the title is edited.
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/commands") &&
      r.request().postDataJSON()?.type === "project.create",
  );
  await page
    .getByRole("menuitem", { name: "新建画布项目", exact: true })
    .click();
  const response = await created;
  assert.equal((await response.json()).status, "applied");
  const id = response.request().postDataJSON().projectId;
  await saved();
  const createdName = page.getByRole("textbox", { name: "项目名称", exact: true });
  await createdName.waitFor();
  await createdName.fill(name);
  await createdName.press("Enter");
  await saved();
  await page.getByRole("button", { name: name, exact: true }).click();
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill(name + " renamed");
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .press("Enter");
  await saved();
  // A successful rename returns focus to the title button, and the keyup can
  // reopen the editor. Escape closes that second edit without changing the name.
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: name + " renamed", exact: true })
    .waitFor();
  assert.equal(
    (await api(`/creation/projects/${id}`)).project.name,
    name + " renamed",
  );
  await page.reload();
  await saved();
  await page
    .getByRole("button", { name: name + " renamed", exact: true })
    .waitFor();
  const inventory = (await api("/creation/projects")).projects;
  await page.goto(base + `/ai-tool/ai-canvas/${old.id}`);
  await page
    .getByRole("alert")
    .getByText(/不支持该工程格式/)
    .waitFor();
  assert.deepEqual((await api("/creation/projects")).projects, inventory);
  await page.getByRole("link", { name: "返回画布首页" }).click();
  await saved();
  await page
    .getByRole("button", { name: name + " renamed", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "与 AI 对话", exact: true }).click();
  const message = page.getByRole("textbox", { name: "消息内容", exact: true });
  await message.waitFor();
  assert.equal((await message.innerText()).replace(/\u200b/g, "").trim(), "");
  assert.equal(
    await page
      .getByRole("button", { name: "发送消息", exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(legacy, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await files(old.path), before);
  assert.deepEqual(
    await readFile(join(health.root, ".opendirector", "models.json")),
    credentials,
  );
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByRole("menuitem", { name: /清除不可读项目/ }).click();
  const cleanup = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/creation/projects/cleanup") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "清除不可读项目", exact: true })
    .getByRole("button", { name: "清除项目", exact: true })
    .click();
  assert.deepEqual((await (await cleanup).json()).removed, [old.name]);
  await page.getByText("已清除 1 个不可读项目。", { exact: true }).waitFor();
  await assert.rejects(access(old.path));
  assert.deepEqual((await api("/creation/projects")).unreadable, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId: id,
      oldProjectId: old.id,
      plainEntry: true,
      initiallyEmpty,
      legacyRequests: legacy.length,
      oldFilesAndCredentialsUnchanged: true,
      oldProjectCleaned: true,
    }),
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  console.error({ errors, legacy });
  throw error;
} finally {
  for (const session of sessions) {
    await fetch(base + `/api/creation/sessions/${session}`, {
      method: "DELETE",
      headers,
    }).catch(() => {});
  }
  await browser.close();
}
