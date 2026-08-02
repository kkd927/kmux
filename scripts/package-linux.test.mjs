import { describe, expect, it } from "vitest";

import {
  electronBuilderLinuxEnv,
  electronBuilderLinuxArgs,
  KMUX_LINUX_PACKAGE_ARCH,
  normalizeLinuxPackageArch
} from "./package-linux.mjs";

describe("Linux package architecture wrapper", () => {
  it("accepts explicit x64 and arm64 flags", () => {
    expect(normalizeLinuxPackageArch(["--x64"], "arm64")).toBe("x64");
    expect(normalizeLinuxPackageArch(["--arm64"], "x64")).toBe("arm64");
    expect(normalizeLinuxPackageArch(["--", "--arm64"], "x64")).toBe("arm64");
  });

  it("falls back to a supported process architecture", () => {
    expect(normalizeLinuxPackageArch([], "x64")).toBe("x64");
    expect(normalizeLinuxPackageArch([], "arm64")).toBe("arm64");
  });

  it("rejects ambiguous and unsupported architectures", () => {
    expect(() =>
      normalizeLinuxPackageArch(["--x64", "--arm64"], "x64")
    ).toThrow(/exactly one/u);
    expect(() => normalizeLinuxPackageArch([], "riscv64")).toThrow(
      /Unsupported Linux package host architecture/u
    );
    expect(() => normalizeLinuxPackageArch(["--ia32"], "x64")).toThrow(
      /Unsupported Linux package argument/u
    );
  });

  it("passes the normalized architecture to electron-builder", () => {
    expect(electronBuilderLinuxArgs("arm64")).toEqual([
      "--config",
      "electron-builder.yml",
      "--linux",
      "AppImage",
      "--publish",
      "never",
      "--arm64"
    ]);
    expect(electronBuilderLinuxEnv("x64", { PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      [KMUX_LINUX_PACKAGE_ARCH]: "x64"
    });
  });
});
