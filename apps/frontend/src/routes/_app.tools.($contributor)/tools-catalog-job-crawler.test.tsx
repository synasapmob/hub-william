import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import ToolsCatalogJobCrawler from "./tools-catalog-job-crawler";

const COMMAND = `curl -fsSL ${window.location.origin}/catalog/contributors/synasapmob/tools/job-crawler/job-crawler.py | python3`;

describe("ToolsCatalogJobCrawler", () => {
  it("shows Location, then Role, then Source, then the command", () => {
    render(<ToolsCatalogJobCrawler />);

    const captions = ["Location", "Role", "Source", "Command"].map((text) =>
      screen.getByText(text),
    );

    captions.slice(1).forEach((caption, index) => {
      expect(
        captions[index].compareDocumentPosition(caption) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
    for (const name of ["HN", "HCM", "DA NANG", "REMOTE"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    for (const name of [
      "ITviec",
      "TopCV",
      "CareerViet",
      "Indeed",
      "Symbotic",
      "Axon",
    ]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    for (const name of ["Fullstack", "Backend", "Mobile", "Product Owner"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
  });

  it("starts with nothing selected and a command that names no option", () => {
    render(<ToolsCatalogJobCrawler />);

    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.getByText(COMMAND)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Folder for the spreadsheet" }),
    ).toHaveValue("");
    expect(
      screen.getByText(/last 30 days unless you pick another/),
    ).toBeVisible();
  });

  it("writes the picked tags into the command, in the catalogue's order", async () => {
    const user = userEvent.setup();

    render(<ToolsCatalogJobCrawler />);
    await user.click(screen.getByRole("button", { name: "REMOTE" }));
    await user.click(screen.getByRole("button", { name: "HCM" }));
    await user.click(screen.getByRole("button", { name: "Backend" }));
    await user.click(screen.getByRole("button", { name: "Fullstack" }));
    await user.click(screen.getByRole("button", { name: "TopCV" }));
    await user.click(screen.getByRole("button", { name: "ITviec" }));
    await user.click(screen.getByRole("button", { name: "60 days" }));

    expect(screen.getByRole("button", { name: "HCM" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "60 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByText(
        `${COMMAND} - --sources=itviec,topcv --role=Fullstack,Backend --location=HCM,Remote --date=60`,
      ),
    ).toBeVisible();
  });

  it("quotes what has a space in it", async () => {
    const user = userEvent.setup();

    render(<ToolsCatalogJobCrawler />);
    await user.click(screen.getByRole("button", { name: "DA NANG" }));
    await user.click(screen.getByRole("button", { name: "Software Engineer" }));

    expect(
      screen.getByText(
        `${COMMAND} - --role='Software Engineer' --location='Da Nang'`,
      ),
    ).toBeVisible();
  });

  it("takes a tag out again, a day count too, and goes back to the shortest command", async () => {
    const user = userEvent.setup();

    render(<ToolsCatalogJobCrawler />);
    await user.click(screen.getByRole("button", { name: "HN" }));
    await user.click(screen.getByRole("button", { name: "Any date" }));

    expect(screen.getByText(/--location=HN --date=0$/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "HN" }));
    await user.click(screen.getByRole("button", { name: "Any date" }));

    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(screen.getByText(COMMAND)).toBeVisible();
  });

  it("follows the folder box, and leaves the folder out when it is cleared", async () => {
    const user = userEvent.setup();

    render(<ToolsCatalogJobCrawler />);

    const folder = screen.getByRole("textbox", {
      name: "Folder for the spreadsheet",
    });

    await user.type(folder, "~/My Jobs");

    expect(
      screen.getByText(`${COMMAND} - --output-dir='~/My Jobs'`),
    ).toBeVisible();

    await user.clear(folder);

    expect(screen.getByText(COMMAND)).toBeVisible();
  });

  it("copies the command as shown, without the prompt", async () => {
    const user = userEvent.setup();

    render(<ToolsCatalogJobCrawler />);
    await user.click(screen.getByRole("button", { name: "TopCV" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await navigator.clipboard.readText()).toBe(
      `${COMMAND} - --sources=topcv`,
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  });
});
