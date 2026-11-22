import { EnvironmentId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope } from "./settingsScope";
import {
  selectEnvironmentAxis,
  selectProjectAxis,
  selectSingleEnvironmentScope,
} from "./settingsScopeAxis";

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });

  it("targets the only environment, and the primary one where a page needs one", () => {
    const environment = (id: string) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      connection: { phase: "connected" as const },
    });
    const select = (environments: ReturnType<typeof environment>[], single: boolean) =>
      selectSingleEnvironmentScope(
        {},
        resolveSettingsScope({}, [], environments),
        environments,
        "second",
        single,
      );
    expect(select([environment("only")], false)).toEqual({ machine: "only" });
    expect(select([environment("first"), environment("second")], false)).toEqual({});
    expect(select([environment("first"), environment("second")], true)).toEqual({
      machine: "second",
    });
  });
});
