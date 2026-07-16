import { describe, it, expect } from "vitest";
import { parseSsdpHeaders } from "../src/api/discovery.js";

describe("parseSsdpHeaders", () => {
  it("parses an SSDP 200 response into a lowercased header map", () => {
    const response = [
      "HTTP/1.1 200 OK",
      "CACHE-CONTROL: max-age=1800",
      "LOCATION: http://10.0.0.5:9197/dmr",
      "SERVER: SHP, UPnP/1.0, Samsung UPnP SDK/1.0",
      "ST: urn:dial-multiscreen-org:service:dial:1",
      "USN: uuid:abc::urn:dial-multiscreen-org:service:dial:1",
      "",
    ].join("\r\n");
    const headers = parseSsdpHeaders(response);
    expect(headers.location).toBe("http://10.0.0.5:9197/dmr");
    expect(headers.server).toContain("Samsung");
    expect(headers.st).toBe("urn:dial-multiscreen-org:service:dial:1");
  });

  it("tolerates values containing colons and skips malformed lines", () => {
    const headers = parseSsdpHeaders("HTTP/1.1 200 OK\r\nLOCATION: http://x:1\r\ngarbage-no-colon\r\n");
    expect(headers.location).toBe("http://x:1");
    expect(headers["garbage-no-colon"]).toBeUndefined();
  });
});
