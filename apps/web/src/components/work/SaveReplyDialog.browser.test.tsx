import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SaveReplyForm, type SaveReplyOutcome } from "./SaveReplyDialog";

it("replaces an existing file only after the user agrees, and with the version it found", async () => {
  const outcomes: Array<SaveReplyOutcome> = [
    { kind: "exists", currentVersion: "version-on-disk" },
    { kind: "saved", relativePath: "notes/Q3 plan.md" },
  ];
  const save = vi.fn(async () => outcomes.shift()!);
  await using _screen = await render(
    <SaveReplyForm markdown={"# Q3 plan\n\nNo table here."} onClose={() => {}} save={save} />,
    // The form reads nothing from the route.
    { router: false },
  );
  await expect.element(page.getByLabelText("File name")).toHaveValue("Q3 plan");
  // A reply without a table cannot become a spreadsheet.
  await expect.element(page.getByRole("button", { name: "Spreadsheet" })).toBeDisabled();
  await page.getByLabelText("Folder in the workspace").fill("notes");
  await expect.element(page.getByText("Saves to notes/Q3 plan.md")).toBeVisible();

  // Tests load no stylesheet, so the dialog's inert layer lies over its unpositioned footer and
  // takes a pointer click. The form is submitted from the keyboard instead.
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText(/A file is already at/)).toBeVisible();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith({ relativePath: "notes/Q3 plan.md", format: "markdown" });

  // Another name is another file, so the agreement to replace does not carry over to it.
  await page.getByLabelText("File name").fill("Q3 plan v2");
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await page.getByLabelText("File name").fill("Q3 plan");
  await expect.element(page.getByRole("button", { name: "Replace file" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(save).toHaveBeenLastCalledWith({
    relativePath: "notes/Q3 plan.md",
    format: "markdown",
    replaceVersion: "version-on-disk",
  });
});
