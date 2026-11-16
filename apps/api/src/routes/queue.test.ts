import { memberships } from "@waitless/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, type Harness, registerUser, startHarness } from "../test/harness.ts";

let h: Harness;
let owner: { cookie: string; id: string };
let staff: { cookie: string; id: string };
let tenantId: string;
let queueId: string;

const TENANT = "barbearia";
const QUEUE = "haircut";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
function call(method: Method, url: string, opts: { cookie?: string; payload?: object } = {}) {
  return h.app.inject({
    method,
    url,
    headers: { origin: APP_ORIGIN, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
}

const admin = (path: string) => `/api/admin/${TENANT}${path}`;
const join = (name: string) =>
  call("POST", `/api/public/q/${TENANT}/${QUEUE}/tickets`, { payload: { name } });

beforeAll(async () => {
  h = await startHarness();
  owner = await registerUser(h.app);
  staff = await registerUser(h.app);

  const tenant = await call("POST", "/api/tenants", {
    cookie: owner.cookie,
    payload: { name: "Barbearia do Zé", slug: TENANT },
  });
  tenantId = tenant.json().tenant.id;
  await h.db.withTenant(tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId: staff.id, role: "staff" }),
  );

  const queue = await call("POST", admin("/queues"), {
    cookie: owner.cookie,
    payload: { name: "Haircut", slug: QUEUE, activeServers: 1, defaultServiceMinutes: 10 },
  });
  expect(queue.statusCode).toBe(201);
  queueId = queue.json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe("queue settings", () => {
  it("are owner-only", async () => {
    const res = await call("POST", admin("/queues"), {
      cookie: staff.cookie,
      payload: { name: "Beard", slug: "beard" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("reject a duplicate queue slug with 409", async () => {
    const res = await call("POST", admin("/queues"), {
      cookie: owner.cookie,
      payload: { name: "Again", slug: QUEUE },
    });

    expect(res.statusCode).toBe(409);
  });

  it("can be listed by staff", async () => {
    const res = await call("GET", admin("/queues"), { cookie: staff.cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json().queues.map((q: { slug: string }) => q.slug)).toContain(QUEUE);
  });
});

describe("customer flow", () => {
  it("joins, sees position and ETA, and never sees other customers", async () => {
    const first = await join("Ana Private");
    const second = await join("Bia");
    expect(second.statusCode).toBe(201);
    const { token, displayCode } = second.json();
    expect(displayCode).toMatch(/^A-\d{3}$/);

    const view = await call("GET", `/api/public/q/${TENANT}/t/${token}`);

    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      tenantName: "Barbearia do Zé",
      queueName: "Haircut",
      displayCode,
      status: "waiting",
    });
    expect(view.json().position).toBeGreaterThanOrEqual(2);
    expect(view.body).not.toContain("Ana Private");
    expect(view.body).not.toContain(first.json().token);
  });

  it("shows queue info with an ETA before joining", async () => {
    const res = await call("GET", `/api/public/q/${TENANT}/${QUEUE}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Haircut", isOpen: true });
    expect(res.json().waitingCount).toBeGreaterThan(0);
  });

  it("can leave once; leaving again is a 409", async () => {
    const { token } = (await join("Caio")).json();

    expect((await call("DELETE", `/api/public/q/${TENANT}/t/${token}`)).statusCode).toBe(204);
    const again = await call("DELETE", `/api/public/q/${TENANT}/t/${token}`);
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toBe("urn:waitless:problem:invalid_transition");
  });

  it("answers 404 for an unknown token or business", async () => {
    expect((await call("GET", `/api/public/q/${TENANT}/t/nope`)).statusCode).toBe(404);
    expect((await call("GET", `/api/public/q/ghost/${QUEUE}`)).statusCode).toBe(404);
  });

  it("can't join a closed queue", async () => {
    await call("POST", admin("/queues"), {
      cookie: owner.cookie,
      payload: { name: "Closed", slug: "closed", isOpen: false },
    });

    const res = await call("POST", `/api/public/q/${TENANT}/closed/tickets`, {
      payload: { name: "Davi" },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("staff board", () => {
  it("calls, serves and finishes; the customer sees each step", async () => {
    // Fresh queue so earlier tests don't affect the order.
    const q = (
      await call("POST", admin("/queues"), {
        cookie: owner.cookie,
        payload: { name: "Beard", slug: "beard", prefix: "B" },
      })
    ).json();
    const joined = (
      await call("POST", `/api/public/q/${TENANT}/beard/tickets`, { payload: { name: "Eva" } })
    ).json();
    const view = async () =>
      (await call("GET", `/api/public/q/${TENANT}/t/${joined.token}`)).json();
    expect(joined.displayCode).toBe("B-001");

    const called = await call("POST", admin(`/queues/${q.id}/call-next`), { cookie: staff.cookie });
    expect(called.statusCode).toBe(200);
    const ticketId = called.json().ticket.id;
    expect((await view()).status).toBe("called");

    const empty = await call("POST", admin(`/queues/${q.id}/call-next`), { cookie: staff.cookie });
    expect(empty.statusCode).toBe(204);

    await call("POST", admin(`/tickets/${ticketId}/start`), { cookie: staff.cookie });
    expect((await view()).status).toBe("serving");
    const finished = await call("POST", admin(`/tickets/${ticketId}/finish`), {
      cookie: staff.cookie,
    });
    expect(finished.json().ticket.status).toBe("done");
    expect((await view()).status).toBe("done");
  });

  it("rejects an illegal action with a 409 problem", async () => {
    const { token } = (await join("Fábio")).json();
    const board = (
      await call("GET", admin(`/queues/${queueId}/board`), { cookie: staff.cookie })
    ).json();
    const ticket = board.waiting.find((t: { customerName: string }) => t.customerName === "Fábio");
    expect(token).toBeTruthy();

    const res = await call("POST", admin(`/tickets/${ticket.id}/finish`), { cookie: staff.cookie });

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("Can't finish a ticket that is waiting");
  });

  it("pushes a called customer back behind the next two", async () => {
    const q = (
      await call("POST", admin("/queues"), {
        cookie: owner.cookie,
        payload: { name: "Nails", slug: "nails", prefix: "N" },
      })
    ).json();
    for (const name of ["Gil", "Hugo", "Iara", "Joana"]) {
      await call("POST", `/api/public/q/${TENANT}/nails/tickets`, { payload: { name } });
    }
    const called = (
      await call("POST", admin(`/queues/${q.id}/call-next`), { cookie: staff.cookie })
    ).json();

    const pushed = await call("POST", admin(`/tickets/${called.ticket.id}/push-back`), {
      cookie: staff.cookie,
      payload: { n: 2 },
    });

    expect(pushed.statusCode).toBe(200);
    const board = (
      await call("GET", admin(`/queues/${q.id}/board`), { cookie: staff.cookie })
    ).json();
    expect(board.waiting.map((t: { customerName: string }) => t.customerName)).toEqual([
      "Hugo",
      "Iara",
      "Gil",
      "Joana",
    ]);
  });

  it("adds walk-ins", async () => {
    const res = await call("POST", admin(`/queues/${queueId}/walk-ins`), {
      cookie: staff.cookie,
      payload: { name: "Seu Jorge" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().ticket).toMatchObject({ customerName: "Seu Jorge", source: "walk_in" });
  });
});

describe("tenant isolation through the API", () => {
  it("can't act on another business's ticket, even with its id", async () => {
    const other = await registerUser(h.app);
    await call("POST", "/api/tenants", {
      cookie: other.cookie,
      payload: { name: "Pet Shop", slug: "pet-shop" },
    });
    const board = (
      await call("GET", admin(`/queues/${queueId}/board`), { cookie: owner.cookie })
    ).json();
    const victim = board.waiting[0];

    const res = await call("POST", `/api/admin/pet-shop/tickets/${victim.id}/call`, {
      cookie: other.cookie,
    });
    const queueRes = await call("GET", `/api/admin/pet-shop/queues/${queueId}/board`, {
      cookie: other.cookie,
    });

    expect(res.statusCode).toBe(404);
    expect(queueRes.statusCode).toBe(404);
  });
});

describe("OpenAPI", () => {
  it("documents the routes at /api/docs", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/docs/json" });

    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    expect(paths).toContain("/api/public/q/{tenantSlug}/{queueSlug}/tickets");
    expect(paths).toContain("/api/admin/{tenantSlug}/queues/{queueId}/call-next");
  });
});
