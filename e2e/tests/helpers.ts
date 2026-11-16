import { type APIRequestContext, expect, request } from "@playwright/test";

/** A business with one queue and its owner, created through the API (fast, no UI). */
export interface Shop {
  tenantSlug: string;
  queueSlug: string;
  queueId: string;
  email: string;
  password: string;
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createShop(baseURL: string): Promise<Shop> {
  // State-changing requests must carry the app's Origin (CSRF check, SPEC §9).
  const api: APIRequestContext = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
  });
  try {
    const id = unique();
    const shop = {
      tenantSlug: `e2e-${id}`,
      queueSlug: "haircut",
      email: `owner-${id}@e2e.waitless.dev`,
      password: "correct horse battery",
    };
    const ok = async (response: Awaited<ReturnType<APIRequestContext["post"]>>) => {
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()) as Record<string, unknown>;
    };
    await ok(
      await api.post("/api/auth/register", {
        data: { name: "E2E Owner", email: shop.email, password: shop.password },
      }),
    );
    await ok(
      await api.post("/api/tenants", { data: { name: `Barbearia ${id}`, slug: shop.tenantSlug } }),
    );
    const queue = await ok(
      await api.post(`/api/admin/${shop.tenantSlug}/queues`, {
        data: { name: "Haircut", slug: shop.queueSlug },
      }),
    );
    return { ...shop, queueId: String(queue.id) };
  } finally {
    await api.dispose();
  }
}
