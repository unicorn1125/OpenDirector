import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const projectId = crypto.randomUUID();
const response = await fetch(
  `${api}/api/creation/projects/${projectId}/commands`,
  {
    method: "POST",
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      projectId,
      type: "project.create",
      payload: { name: "Locale test" },
    }),
  },
);
assert.ok(response.ok, `${response.status}: ${await response.text()}`);

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US" });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page
    .getByText("Saved on this device", { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(await page.locator("html").getAttribute("lang"), "en-US");
  await page.evaluate(() =>
    localStorage.setItem("opendirector.locale.v1", "zh-CN"),
  );
  await page.reload();
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  console.log("Browser locale checks passed");
} finally {
  await browser.close();
}
