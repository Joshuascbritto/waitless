import { describe, expect, it } from "vitest";
import { LoginInputSchema, RegisterInputSchema } from "./auth.ts";
import { CreateTenantInputSchema, SlugSchema } from "./tenant.ts";

describe("RegisterInputSchema", () => {
  it("normalizes the email", () => {
    const input = RegisterInputSchema.parse({
      email: "  Ana@Example.COM ",
      password: "long enough",
      name: " Ana ",
    });

    expect(input.email).toBe("ana@example.com");
    expect(input.name).toBe("Ana");
  });

  it("rejects short passwords and invalid emails", () => {
    expect(
      RegisterInputSchema.safeParse({ email: "ana@example.com", password: "short", name: "A" })
        .success,
    ).toBe(false);
    expect(
      RegisterInputSchema.safeParse({ email: "not-an-email", password: "long enough", name: "A" })
        .success,
    ).toBe(false);
  });
});

describe("LoginInputSchema", () => {
  it("accepts any non-empty password, so old passwords keep working if rules change", () => {
    expect(LoginInputSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });
});

describe("SlugSchema", () => {
  it.each(["barbearia-do-ze", "pet123", "abc"])("accepts %s", (slug) => {
    expect(SlugSchema.parse(slug)).toBe(slug);
  });

  it("lowercases before validating", () => {
    expect(SlugSchema.parse("Barbearia")).toBe("barbearia");
  });

  it.each(["ab", "-start", "end-", "double--hyphen", "with space", "acentuação"])(
    "rejects %s",
    (slug) => {
      expect(SlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe("CreateTenantInputSchema", () => {
  it("defaults the timezone and rejects unknown ones", () => {
    expect(CreateTenantInputSchema.parse({ name: "Shop", slug: "shop" }).timezone).toBe(
      "America/Bahia",
    );
    expect(
      CreateTenantInputSchema.safeParse({ name: "Shop", slug: "shop", timezone: "Mars/Olympus" })
        .success,
    ).toBe(false);
  });
});
