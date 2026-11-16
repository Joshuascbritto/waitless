/**
 * The core flow (SPEC §12): a customer joins from a phone, staff clicks
 * "Call next", and the phone shows it's their turn without a reload.
 */
import { devices, expect, test } from "@playwright/test";
import { createShop } from "./helpers.ts";

test("the customer's phone updates live when staff calls next", async ({ browser, baseURL }) => {
  const shop = await createShop(baseURL ?? "");

  // Two independent browsers: a phone with no session, and the owner's laptop.
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const laptop = await browser.newContext();
  try {
    const customer = await phone.newPage();
    await customer.goto(`/q/${shop.tenantSlug}/${shop.queueSlug}`);
    await customer.getByLabel("Your name").fill("Ana");
    await customer.getByRole("button", { name: "Join the line" }).click();

    await expect(customer).toHaveURL(new RegExp(`/q/${shop.tenantSlug}/t/`));
    await expect(customer.getByRole("heading", { name: "You're in line" })).toBeVisible();
    await expect(customer.getByText("A-001")).toBeVisible();

    const staff = await laptop.newPage();
    await staff.goto("/login");
    await staff.getByLabel("Email").fill(shop.email);
    await staff.getByLabel("Password").fill(shop.password);
    await staff.getByRole("button", { name: /log in|sign in/i }).click();
    await expect(staff).toHaveURL(/\/tenants/);

    await staff.goto(`/admin/${shop.tenantSlug}/queues/${shop.queueId}`);
    await expect(staff.getByText("Ana")).toBeVisible();
    await staff.getByRole("button", { name: "Call next" }).click();

    // No reload: the ticket page heard it over SSE.
    await expect(customer.getByRole("heading", { name: "It's your turn!" })).toBeVisible();
  } finally {
    await phone.close();
    await laptop.close();
  }
});

test("a customer can leave the line", async ({ page, baseURL }) => {
  const shop = await createShop(baseURL ?? "");

  await page.goto(`/q/${shop.tenantSlug}/${shop.queueSlug}`);
  await page.getByLabel("Your name").fill("Bruno");
  await page.getByRole("button", { name: "Join the line" }).click();
  await expect(page.getByRole("heading", { name: "You're in line" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /leave/i }).click();
  await expect(page.getByRole("heading", { name: "You left the line" })).toBeVisible();
});
