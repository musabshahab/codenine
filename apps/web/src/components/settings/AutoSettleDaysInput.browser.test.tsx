import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AutoSettleDaysInput } from "./AutoSettleDaysInput";

it("saves typed days once, when the field commits, and never a partial number", async () => {
  const onCommit = vi.fn();
  await using screen = await render(<AutoSettleDaysInput value={7} onCommit={onCommit} />);
  const input = screen.getByLabelText("Days of inactivity before marking done");

  await userEvent.clear(input);
  await userEvent.type(input, "30");
  expect(onCommit).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onCommit.mock.calls).toEqual([[30]]));
  await expect.element(input).toHaveFocus();
});
