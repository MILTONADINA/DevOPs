// Table-driven tests for the numeric webhook address guard (no string-prefix checks).

import { describe, test, expect } from "vitest";
import { isPublicAddress } from "../../src/webhooks/address-guard";

const BLOCKED = [
  "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
  "0.0.0.0", "0.1.2.3", "240.0.0.1", "224.0.0.1", "255.255.255.255", "192.0.0.1", "198.18.0.1", "198.19.255.255",
  "::", "::1", "fc00::1", "fd00::1", "fe80::1", "febf::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::127.0.0.1", "::7f00:1",
  "64:ff9b::7f00:1", "64:ff9b:1::7f00:1", "64:ff9b:1::808:808", "64:ff9b::a9fe:a9fe", "2002:0a00:0001::", "2002:7f00:0001::1", "2002:a9fe:a9fe::",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1",
  "not-an-ip", "", "1.2.3", "999.1.1.1", "12345::",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b::0808:0808", "2002:0808:0808::1", "::ffff:8.8.8.8"];

describe("isPublicAddress", () => {
  test.each(BLOCKED)("blocks %j", (addr) => {
    expect(isPublicAddress(addr)).toBe(false);
  });
  test.each(ALLOWED)("allows %s", (addr) => {
    expect(isPublicAddress(addr)).toBe(true);
  });
});
