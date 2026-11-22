import { DEFAULT_UNIFIED_SETTINGS } from "@codenine/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";
import { SettingsPageContainer } from "./settingsLayout";
import { TypographySection } from "./TypographySettings";

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));
// The previews mount Ghostty and Shiki, which this test does not exercise.
vi.mock(import("./SettingsFontPreviews"), () => ({
  CodeFontPreview: () => <div />,
  PromptFontPreview: () => <div />,
  TerminalFontPreview: () => <div />,
}));
// The scope sentence reads environments, which this test does not exercise.
vi.mock(import("./SettingsScopeSentence"), () => ({
  SETTINGS_DEVICE_ONLY_PATHS: new Set<string>(),
  SettingsScopeSentence: () => null,
}));

function setup(advanced: boolean | null) {
  removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  if (advanced !== null) {
    setLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, advanced, Schema.Boolean);
  }
  return { [Symbol.dispose]: () => removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY) };
}

describe("TypographySection", () => {
  it.each([
    { advanced: null, target: "terminal-font", landsOn: "separate-fonts" },
    { advanced: false, target: "prompt-font", landsOn: "separate-fonts" },
    { advanced: true, target: "terminal-font", landsOn: "terminal-font" },
  ])(
    "lands a jump to $target on $landsOn with separate fonts $advanced, leaving the flag alone",
    async ({ advanced, target, landsOn }) => {
      using _storage = setup(advanced);
      await using _screen = await render(
        <SettingsPageContainer>
          <TypographySection />
        </SettingsPageContainer>,
        { router: `/settings/appearance#${target}` },
      );

      await vi.waitFor(() => expect(document.activeElement?.id).toBe(landsOn));
      expect(getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean)).toBe(advanced);
    },
  );
});
