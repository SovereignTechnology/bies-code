import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TestApp } from "@/test/TestApp";
import { InferredPRStackMap } from "./InferredPRParentLinks";

describe("InferredPRStackMap", () => {
  it("renders a two-layer inferred map and links the parent PR", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={{
            status: "matched",
            child: { rootId: "c".repeat(64), subject: "Follow-up" },
            parents: [{ rootId: "a".repeat(64), subject: "Foundation" }],
          }}
          items={[
            { rootId: "a".repeat(64), subject: "Foundation" },
            { rootId: "c".repeat(64), subject: "Follow-up" },
          ]}
          currentRootId={"c".repeat(64)}
          repoPath="/owner/repo"
          relayHints={[]}
          layer={{ position: 2, size: 2 }}
        />
      </TestApp>,
    );
    expect(
      screen.getByText("Part of an inferred 2-PR stack"),
    ).toBeInTheDocument();
    expect(screen.getByText("· 2 of 2")).toBeInTheDocument();
    expect(
      screen.getByText("Follow-up").closest("[aria-current]"),
    ).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("(you are here)")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Foundation" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/owner\/repo\/prs\/nevent1/),
    );
  });

  it("renders every ambiguous parent as a link", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={{
            status: "ambiguous",
            child: { rootId: "c".repeat(64), subject: "Follow-up" },
            parents: [
              { rootId: "a".repeat(64), subject: "Foundation API" },
              { rootId: "b".repeat(64), subject: "Relay cache refactor" },
            ],
          }}
          items={[]}
          currentRootId={"c".repeat(64)}
          repoPath="/owner/repo"
          relayHints={[]}
        />
      </TestApp>,
    );
    expect(screen.getByText("Possible stack parents")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(
      screen.getByText("Multiple PRs advertise the matching Git commit."),
    ).toBeInTheDocument();
  });

  it("links the child when viewing the foundation PR", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={undefined}
          items={[
            { rootId: "a".repeat(64), subject: "Foundation" },
            { rootId: "c".repeat(64), subject: "Follow-up" },
          ]}
          currentRootId={"a".repeat(64)}
          repoPath="/owner/repo"
          relayHints={[]}
          layer={{ position: 1, size: 2 }}
        />
      </TestApp>,
    );
    expect(screen.getByText("· 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Follow-up" })).toBeInTheDocument();
    expect(screen.getByText("Foundation")).toBeInTheDocument();
  });

  it("shows an ambiguous child from a possible parent page", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={undefined}
          items={[]}
          currentRootId={"a".repeat(64)}
          ambiguousChildren={[
            { rootId: "c".repeat(64), subject: "Possible child" },
          ]}
          repoPath="/owner/repo"
          relayHints={[]}
        />
      </TestApp>,
    );
    expect(screen.getByText("Possible stacked children")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Possible child" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This PR may be their parent; another root advertises the same commit.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a fork without inventing a linear position", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={undefined}
          items={[{ rootId: "a".repeat(64), subject: "Foundation" }]}
          currentRootId={"a".repeat(64)}
          branchedChildren={[
            { rootId: "b".repeat(64), subject: "Frontend branch" },
            { rootId: "c".repeat(64), subject: "Backend branch" },
          ]}
          repoPath="/owner/repo"
          relayHints={[]}
        />
      </TestApp>,
    );

    expect(screen.getByText("Inferred stack branches")).toBeInTheDocument();
    expect(screen.queryByText(/of 3/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Foundation").closest("[aria-current]"),
    ).toHaveAttribute("aria-current", "step");
    expect(
      screen.getByRole("link", { name: "Frontend branch" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Backend branch" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("↳")).toHaveLength(2);
  });

  it("suppresses an ancestor position when the current PR forks", () => {
    render(
      <TestApp>
        <InferredPRStackMap
          relation={{
            status: "matched",
            child: { rootId: "b".repeat(64), subject: "Middle" },
            parents: [{ rootId: "a".repeat(64), subject: "Foundation" }],
          }}
          items={[
            { rootId: "a".repeat(64), subject: "Foundation" },
            { rootId: "b".repeat(64), subject: "Middle" },
          ]}
          currentRootId={"b".repeat(64)}
          branchedChildren={[
            { rootId: "c".repeat(64), subject: "Left branch" },
            { rootId: "d".repeat(64), subject: "Right branch" },
          ]}
          repoPath="/owner/repo"
          relayHints={[]}
          layer={{ position: 2, size: 2 }}
        />
      </TestApp>,
    );

    expect(screen.getByText("Inferred stack branches")).toBeInTheDocument();
    expect(screen.queryByText("· 2 of 2")).not.toBeInTheDocument();
    expect(screen.getAllByText("↳")).toHaveLength(2);
  });
});
