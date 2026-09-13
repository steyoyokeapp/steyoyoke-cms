import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// These are route-composition constraints, not wall-clock performance assertions.
describe("ready content reveal boundaries", () => {
  it("does not wrap the cheap Artists list in an automatic loading boundary", () => {
    for (const segment of ["src/app", "src/app/admin", "src/app/admin/artists"])
      for (const extension of ["tsx", "ts", "jsx", "js"])
        expect(existsSync(resolve(segment, `loading.${extension}`))).toBe(false);
  });
  it("awaits the bounded initial Media page without an explicit Suspense fallback", () => {
    const source = ts.createSourceFile("page.tsx", readFileSync("src/app/admin/media/page.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let suspense = 0;
    let initialAwait = 0;
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "Suspense") suspense++;
      if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "InitialMedia") initialAwait++;
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(suspense).toBe(0);
    expect(initialAwait).toBe(1);
  });
});
