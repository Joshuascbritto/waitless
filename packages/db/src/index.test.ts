import { describe, expect, it, vi } from "vitest";
import { pingDatabase } from "./index.ts";

describe("pingDatabase", () => {
  it("runs a trivial query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });

    await pingDatabase({ query });

    expect(query).toHaveBeenCalledWith("select 1");
  });

  it("propagates connection failures", async () => {
    const query = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(pingDatabase({ query })).rejects.toThrow("ECONNREFUSED");
  });
});
