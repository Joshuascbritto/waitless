/**
 * Records the README demo: a phone joins the "Beard" queue of the seeded
 * Barbearia Demo, the owner calls next twice on a laptop, and the phone shows
 * "It's your turn!" live. Then takes the README screenshots.
 *
 * Needs Google Chrome, ffmpeg, and the full stack with fresh demo data:
 *   docker compose --profile full up -d --build
 *   docker compose --profile full run --rm --no-deps api-1 node dist/seed.js --reset-demo
 *   pnpm --filter @waitless/e2e record-demo
 *
 * Writes docs/images/demo.gif and docs/images/*.png.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "@playwright/test";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("../../docs/images/", import.meta.url).pathname;
const TENANT = "barbearia-demo";
const VIDEO_HEIGHT = 720;
const phoneDevice = devices["Pixel 7"];
const laptopSize = { width: 1280, height: 800 };

async function signIn(browser: Browser): Promise<StorageState> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@demo.waitless.dev");
  await page.getByLabel("Password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/tenants/);
  const state = await context.storageState();
  await context.close();
  return state;
}

async function queueId(page: Page, slug: string): Promise<string> {
  const response = await page.request.get(`/api/admin/${TENANT}/queues`);
  const { queues } = (await response.json()) as { queues: { id: string; slug: string }[] };
  const queue = queues.find((q) => q.slug === slug);
  if (!queue) throw new Error(`queue ${slug} not found; seed the demo first`);
  return queue.id;
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function recordDemo(browser: Browser, storageState: StorageState) {
  const videos = mkdtempSync(join(tmpdir(), "waitless-demo-"));
  const phoneSize = phoneDevice.viewport;
  const [phone, laptop] = await Promise.all([
    browser.newContext({
      ...phoneDevice,
      baseURL: BASE_URL,
      // Headless denies notifications by default; the GIF should show the "notify me" offer.
      permissions: ["notifications"],
      recordVideo: { dir: join(videos, "phone"), size: phoneSize },
    }),
    browser.newContext({
      baseURL: BASE_URL,
      viewport: laptopSize,
      storageState,
      recordVideo: { dir: join(videos, "laptop"), size: laptopSize },
    }),
  ]);
  const [customer, staff] = await Promise.all([phone.newPage(), laptop.newPage()]);
  const beard = await queueId(staff, "beard");

  await Promise.all([
    staff.goto(`/admin/${TENANT}/queues/${beard}`),
    customer.goto(`/q/${TENANT}/beard`),
  ]);
  await pause(customer, 1200);
  await customer.getByLabel("Your name").pressSequentially("Marina", { delay: 90 });
  await pause(customer, 400);
  await customer.getByRole("button", { name: "Join the line" }).click();
  await customer.getByRole("heading", { name: "You're in line" }).waitFor();
  await staff.getByText("Marina").waitFor();
  await pause(staff, 2000);

  for (let i = 0; i < 2; i++) {
    await staff.getByRole("button", { name: "Call next" }).click();
    await pause(staff, 1800);
  }
  await customer.getByRole("heading", { name: "It's your turn!" }).waitFor();
  await pause(customer, 2500);

  const [phoneVideo, laptopVideo] = await Promise.all([
    customer.video()?.path(),
    staff.video()?.path(),
  ]);
  await Promise.all([phone.close(), laptop.close()]);
  if (!phoneVideo || !laptopVideo) throw new Error("videos were not recorded");

  // Side by side at the same height, then a two-pass palette for a sharp, small GIF.
  const filter = [
    `[0:v]scale=-2:${VIDEO_HEIGHT}:flags=lanczos[laptop]`,
    // A light gutter so the phone reads as its own screen.
    `[1:v]scale=-2:${VIDEO_HEIGHT}:flags=lanczos,pad=iw+24:ih:24:0:color=0xd4d4d4[phone]`,
    "[laptop][phone]hstack=inputs=2,fps=12,scale=1100:-2:flags=lanczos,split[a][b]",
    "[a]palettegen=max_colors=96:stats_mode=diff[palette]",
    "[b][palette]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  ].join(";");
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    laptopVideo,
    "-i",
    phoneVideo,
    "-filter_complex",
    filter,
    join(OUT, "demo.gif"),
  ]);
  rmSync(videos, { recursive: true, force: true });
}

async function screenshots(browser: Browser, storageState: StorageState) {
  const laptop = await browser.newContext({
    baseURL: BASE_URL,
    viewport: laptopSize,
    storageState,
  });
  const page = await laptop.newPage();
  const haircut = await queueId(page, "haircut");

  await page.goto(`/admin/${TENANT}/queues/${haircut}`);
  await page.getByRole("button", { name: "Call next" }).waitFor();
  await page.screenshot({ path: join(OUT, "board.png") });

  await page.goto(`/admin/${TENANT}/metrics?range=30d`);
  await page.getByRole("heading", { name: "Peak hours" }).waitFor();
  await page.screenshot({ path: join(OUT, "metrics.png"), fullPage: true });
  await laptop.close();

  const phone = await browser.newContext({
    ...phoneDevice,
    baseURL: BASE_URL,
    permissions: ["notifications"],
  });
  const customer = await phone.newPage();
  await customer.goto(`/q/${TENANT}/haircut`);
  await customer.getByLabel("Your name").fill("Rafael");
  await customer.getByRole("button", { name: "Join the line" }).click();
  await customer.getByRole("heading", { name: "You're in line" }).waitFor();
  await customer.screenshot({ path: join(OUT, "ticket.png") });
  await phone.close();
}

mkdirSync(OUT, { recursive: true });
// Full Chrome, not Playwright's headless shell: the shell reports
// notifications as denied no matter what, which would show the wrong UI.
const browser = await chromium.launch({ channel: process.env.DEMO_CHROME_CHANNEL ?? "chrome" });
try {
  const state = await signIn(browser);
  await recordDemo(browser, state);
  await screenshots(browser, state);
  console.log(`wrote demo.gif, board.png, metrics.png, ticket.png to ${OUT}`);
} finally {
  await browser.close();
}
