import { expect, test } from "@playwright/test";
import { createShop } from "./helpers.ts";

test.beforeEach(async ({ page, baseURL }, testInfo) => {
  const shop = await createShop(baseURL ?? "");
  testInfo.annotations.push({ type: "shop", description: shop.tenantSlug });
  await page.goto("/login");
  await page.getByLabel("Email").fill(shop.email);
  await page.getByLabel("Password").fill(shop.password);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await expect(page).toHaveURL(/\/tenants/);
  await page.goto(`/admin/${shop.tenantSlug}`);
});

test("the QR poster links to the queue's public page", async ({ page, baseURL }) => {
  await page.getByRole("link", { name: /Haircut/ }).click();
  await page.getByRole("link", { name: "QR poster" }).click();

  const qr = page.getByRole("img", { name: /^QR code for / });
  await expect(qr).toBeVisible();
  const label = (await qr.getAttribute("aria-label")) ?? "";
  const url = new URL(label.replace("QR code for ", ""));
  expect(url.origin).toBe(new URL(baseURL ?? "").origin);
  expect(url.pathname).toMatch(/^\/q\/e2e-[a-z0-9]+\/haircut$/);
});

test("the metrics page shows tiles, the chart and the heatmap", async ({ page }) => {
  await page.getByRole("link", { name: "Metrics" }).click();

  await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
  await expect(page.getByText("Average wait")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Served per day" })).toBeVisible();
  await expect(page.getByRole("table", { name: /joined, by weekday and hour/ })).toBeVisible();

  await page.getByRole("link", { name: "30 days" }).click();
  await expect(page).toHaveURL(/range=30d/);
});
