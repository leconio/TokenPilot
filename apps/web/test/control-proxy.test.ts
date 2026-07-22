import { describe, expect, it } from "vitest";

import { ControlProxyOriginError, controlProxyRequestHeaders } from "../lib/control-proxy";

describe("Web control proxy origin handling", () => {
  it("accepts a same-origin LAN request without forwarding its public Origin internally", () => {
    const incoming = new Headers({
      host: "192.168.51.207:15000",
      origin: "http://192.168.51.207:15000",
      "sec-fetch-site": "same-origin",
      cookie: "cp_session=session",
      "x-csrf-token": "csrf-value",
    });

    const outgoing = controlProxyRequestHeaders(
      "http://web:3000/api/control/web/setup/initialize",
      incoming,
    );

    expect(outgoing.get("origin")).toBeNull();
    expect(outgoing.get("sec-fetch-site")).toBe("same-origin");
    expect(outgoing.get("cookie")).toBe("cp_session=session");
    expect(outgoing.get("x-csrf-token")).toBe("csrf-value");
  });

  it("accepts a same-origin localhost alias for the same deployment", () => {
    const incoming = new Headers({
      host: "localhost:15000",
      origin: "http://localhost:15000",
      "sec-fetch-site": "same-origin",
    });

    expect(() =>
      controlProxyRequestHeaders("http://web:3000/api/control/web/setup/initialize", incoming),
    ).not.toThrow();
  });

  it("uses the forwarded protocol when TLS terminates at the ingress", () => {
    const incoming = new Headers({
      host: "pilot.example.test",
      origin: "https://pilot.example.test",
      "sec-fetch-site": "same-origin",
      "x-forwarded-proto": "https",
    });

    expect(() =>
      controlProxyRequestHeaders("http://web:3000/api/control/web/session/login", incoming),
    ).not.toThrow();
  });

  it("rejects a mismatched Origin and explicit cross-site requests", () => {
    expect(() =>
      controlProxyRequestHeaders(
        "http://web:3000/api/control/web/setup/initialize",
        new Headers({
          host: "192.168.51.207:15000",
          origin: "https://attacker.example",
          "sec-fetch-site": "same-site",
        }),
      ),
    ).toThrow(ControlProxyOriginError);

    expect(() =>
      controlProxyRequestHeaders(
        "http://web:3000/api/control/web/setup/initialize",
        new Headers({ host: "192.168.51.207:15000", "sec-fetch-site": "cross-site" }),
      ),
    ).toThrow(ControlProxyOriginError);
  });
});
