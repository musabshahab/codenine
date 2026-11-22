import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@codenine/contracts";
import { createModelSelection } from "@codenine/shared/model";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("offers None first and checks it, not a model, while nothing is selected", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
      ],
    ],
  ]);

  function Picker() {
    const [selection, setSelection] = useState<ModelSelection | null>(null);
    return (
      <>
        <output aria-label="Fallback">{selection?.model ?? "none"}</output>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={selection?.instanceId ?? null}
          model={selection?.model ?? ""}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          triggerAriaLabel="Fallback model"
          onSelectNone={() => setSelection(null)}
          onInstanceModelChange={(picked, model) =>
            setSelection(createModelSelection(picked, model))
          }
        />
      </>
    );
  }

  await using screen = await render(<Picker />);
  const trigger = screen.getByRole("button", { name: "Fallback model" });
  await trigger.click();
  const none = page.getByRole("option", { name: "None" });
  await expect.element(page.getByRole("option").first()).toHaveTextContent("None");
  await expect.element(none).toHaveAttribute("aria-selected", "true");
  await expect
    .element(page.getByRole("option", { name: /Original model/ }))
    .toHaveAttribute("aria-selected", "false");

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect
    .element(screen.getByRole("status", { name: "Fallback" }))
    .toHaveTextContent("second");
  await trigger.click();
  await expect.element(none).toHaveAttribute("aria-selected", "false");
  await expect
    .element(page.getByRole("option", { name: /Second model/ }))
    .toHaveAttribute("aria-selected", "true");

  await none.click();
  await expect.element(none).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status", { name: "Fallback" })).toHaveTextContent("none");
});
