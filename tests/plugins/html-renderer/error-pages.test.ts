import { describe, expect, it } from "vitest";
import {
  renderNotFoundPage,
  renderServerErrorPage,
} from "../../../src/plugins/html-renderer/src/error-pages.js";

describe("default 404 page", () => {
  it("renders a full HTML document through the shared error-page layout", () => {
    const html = renderNotFoundPage();

    // Comes from the shared layout, not something the 404 template defines itself --
    // proves this actually composed through compileWithLayout (feature #48), not a
    // standalone hand-written string.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>404 Not Found</title>");
    expect(html).toContain("404");
  });

  it("safely echoes an optional request path, HTML-escaped like any other variable", () => {
    const html = renderNotFoundPage({ path: "/widgets/<script>alert(1)</script>" });

    expect(html).toContain("/widgets/&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("omits the 'no route matches' line entirely when no path is given", () => {
    const html = renderNotFoundPage();

    expect(html).not.toContain("No route matches");
  });
});

describe("default 500 page -- no stack-trace leak in production", () => {
  const secretError = new Error("connection to db-prod-primary.internal failed: bad password");

  it("hides the error message and stack trace when nodeEnv is production", () => {
    const html = renderServerErrorPage({ nodeEnv: "production", error: secretError });

    expect(html).toContain("500");
    expect(html).toContain("Something went wrong on our end");
    expect(html).not.toContain("connection to db-prod-primary.internal");
    expect(html).not.toContain(secretError.message);

    expect(secretError.stack).toBeDefined();
    const stackLines = String(secretError.stack)
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(stackLines.length).toBeGreaterThan(0);
    for (const line of stackLines) {
      expect(html).not.toContain(line);
    }
  });

  it("shows the error message and stack trace when nodeEnv is development", () => {
    const html = renderServerErrorPage({ nodeEnv: "development", error: secretError });

    expect(html).toContain("connection to db-prod-primary.internal failed: bad password");
    expect(html).toContain(String(secretError.stack));
  });

  it("hides detail in test mode too -- the guard is 'only development', not 'not production'", () => {
    const html = renderServerErrorPage({ nodeEnv: "test", error: secretError });

    expect(html).not.toContain("connection to db-prod-primary.internal");
  });

  it("still renders a safe page when no error is supplied at all", () => {
    const prod = renderServerErrorPage({ nodeEnv: "production" });
    const dev = renderServerErrorPage({ nodeEnv: "development" });

    expect(prod).toContain("500");
    expect(dev).toContain("500");
  });

  it("HTML-escapes error detail in development, so an attacker-influenced message can't break out", () => {
    const html = renderServerErrorPage({
      nodeEnv: "development",
      error: new Error("<script>alert(1)</script>"),
    });

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders through the same shared error-page layout as the 404 page", () => {
    const html = renderServerErrorPage({ nodeEnv: "production" });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>500 Internal Server Error</title>");
  });
});
