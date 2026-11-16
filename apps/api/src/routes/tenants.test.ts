import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

async function createTenant(cookie: string, slug: string, name = "Barbearia do Zé") {
  return h.app.inject({
    method: "POST",
    url: "/api/tenants",
    headers: { origin: APP_ORIGIN, cookie },
    payload: { name, slug },
  });
}

describe("POST /api/tenants", () => {
  it("creates a tenant and makes the creator its owner", async () => {
    const owner = await registerUser(h.app);

    const res = await createTenant(owner.cookie, "Barbearia-Do-Ze");

    expect(res.statusCode).toBe(201);
    expect(res.json().tenant).toMatchObject({
      slug: "barbearia-do-ze",
      name: "Barbearia do Zé",
      timezone: "America/Bahia",
    });
    const me = await h.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: owner.cookie },
    });
    expect(me.json().memberships).toEqual([
      {
        tenantId: res.json().tenant.id,
        tenantSlug: "barbearia-do-ze",
        tenantName: "Barbearia do Zé",
        role: "owner",
      },
    ]);
  });

  it("rejects a taken slug with 409", async () => {
    const first = await registerUser(h.app);
    const second = await registerUser(h.app);
    await createTenant(first.cookie, "pet-shop");

    const res = await createTenant(second.cookie, "pet-shop");

    expect(res.statusCode).toBe(409);
  });

  it("requires a session", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/tenants",
      headers: { origin: APP_ORIGIN },
      payload: { name: "Shop", slug: "no-session" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("/api/admin/:tenantSlug membership check", () => {
  it("lets a member in and returns the tenant context", async () => {
    const owner = await registerUser(h.app);
    await createTenant(owner.cookie, "clinica-sorriso", "Clínica Sorriso");

    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/clinica-sorriso",
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tenant: { slug: "clinica-sorriso", name: "Clínica Sorriso" },
      role: "owner",
    });
  });

  it("answers 404 to a signed-in non-member, the same as for a slug that doesn't exist", async () => {
    const owner = await registerUser(h.app);
    const outsider = await registerUser(h.app);
    await createTenant(owner.cookie, "oficina-do-joao");

    const notMember = await h.app.inject({
      method: "GET",
      url: "/api/admin/oficina-do-joao",
      headers: { cookie: outsider.cookie },
    });
    const missing = await h.app.inject({
      method: "GET",
      url: "/api/admin/does-not-exist",
      headers: { cookie: outsider.cookie },
    });

    expect(notMember.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(notMember.json().detail).toBe(missing.json().detail);
  });

  it("answers 401 without a session", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/admin/anything" });

    expect(res.statusCode).toBe(401);
  });
});
