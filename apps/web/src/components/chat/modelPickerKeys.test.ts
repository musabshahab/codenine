import { ProviderInstanceId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerAgentKey,
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerAgentKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";

describe("model picker item keys", () => {
  it("keeps model, legacy section and agent keys distinct for colliding names", () => {
    const modelKey = modelPickerModelKey(ProviderInstanceId.make("legacy-models"), "codex");
    const sectionKey = modelPickerLegacySectionKey(ProviderInstanceId.make("codex"));

    expect(modelKey).not.toBe(sectionKey);
    expect(parseModelPickerLegacySectionKey(modelKey)).toBeNull();
    expect(parseModelPickerAgentKey(modelKey)).toBeNull();
    expect(parseModelPickerAgentKey(modelPickerAgentKey(null))).toEqual({ name: null });
    expect(parseModelPickerAgentKey(modelPickerAgentKey("codex"))).toEqual({ name: "codex" });
    expect(parseModelPickerModelKey(modelPickerAgentKey("codex"))).toBeNull();
    expect(parseModelPickerModelKey(modelKey)).toEqual({
      instanceId: "legacy-models",
      slug: "codex",
    });
  });

  it("round-trips arbitrary strings without throwing", () => {
    const instanceId = ProviderInstanceId.make("custom");
    const slug = "model:\udfff";

    const key = modelPickerModelKey(instanceId, slug);

    expect(parseModelPickerModelKey(key)).toEqual({ instanceId, slug });
  });
});
