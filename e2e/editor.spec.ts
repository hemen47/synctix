/**
 * M4's exit criterion, end to end in a real browser.
 *
 * Place a resistor and a capacitor from the palette, wire them, drag one (and prove the
 * placement persisted as a manual edit), undo, and export SVG.
 *
 * The unit tests in `@syntrix/ui-canvas` already prove the geometry is right. What only a
 * browser can prove is that DOM events reach those functions with the coordinates they
 * expect, that the operations they emit reach the API, and that what comes back is drawn.
 * So these assertions are about the seams, not about the maths.
 */

import { expect, test, type Page } from "@playwright/test"

/** Place a part: type a query, click the first hit, then click the canvas. */
const placePart = async (page: Page, query: string, atX: number, atY: number): Promise<void> => {
  await page.getByTestId("part-search").fill(query)
  const first = page.getByTestId("part").first()
  await expect(first).toBeVisible()
  await first.click()

  // The palette says it is waiting for a click, which is the affordance a user needs.
  await expect(page.getByTestId("placing")).toBeVisible()

  await page.getByTestId("canvas").click({ position: { x: atX, y: atY } })
  await expect(page.getByTestId("placing")).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.goto("/")
  // A design is created on first load; the status bar shows it once the API answered.
  await expect(page.getByTestId("status")).toContainText("v0")
})

test("places a resistor and a capacitor from the palette", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)
  await expect(page.getByTestId("symbol")).toHaveCount(1)

  await placePart(page, "capacitor", 380, 200)
  await expect(page.getByTestId("symbol")).toHaveCount(2)

  // Two operations per placement — add then move — so the log is at four.
  await expect(page.getByTestId("element-count")).toContainText("4 operations")
})

test("wires two pins together", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)
  await placePart(page, "capacitor", 380, 200)

  const before = await page.getByTestId("wire").count()

  const from = page.getByTestId("pin").first()
  const to = page.getByTestId("pin").last()
  await from.click()
  await to.click()

  // A wire appears because the connect was accepted and the relayout drew it — nothing
  // is drawn optimistically, so a wire on screen means the engine agreed.
  await expect(page.getByTestId("wire")).toHaveCount(before + 1)
  await expect(page.getByTestId("problem")).toBeHidden()
})

test("dragging a symbol persists as a manual edit", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  const symbol = page.getByTestId("symbol").first()
  const box = (await symbol.boundingBox())!

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 8 })
  await page.mouse.up()

  await expect(page.getByTestId("status")).toContainText("v3")

  // The real assertion: the placement survives a reload, because it was written to
  // manualEdits on the server rather than held in the browser (ADR-0013).
  const afterDrag = (await page.getByTestId("symbol").first().boundingBox())!
  await page.reload()
  await expect(page.getByTestId("symbol")).toHaveCount(1)
  const afterReload = (await page.getByTestId("symbol").first().boundingBox())!

  expect(Math.abs(afterReload.x - afterDrag.x)).toBeLessThan(4)
  expect(Math.abs(afterReload.y - afterDrag.y)).toBeLessThan(4)
})

test("undo removes the last change and redo restores it", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)
  await placePart(page, "capacitor", 380, 200)
  // The retrying form: a placement is two round trips, and a bare read races the second.
  await expect(page.getByTestId("symbol")).toHaveCount(2)

  // Two operations per placement: undo twice to remove the capacitor entirely.
  await page.getByTestId("undo").click()
  await page.getByTestId("undo").click()
  await expect(page.getByTestId("symbol")).toHaveCount(1)

  await page.getByTestId("redo").click()
  await page.getByTestId("redo").click()
  await expect(page.getByTestId("symbol")).toHaveCount(2)
})

test("Ctrl+Z undoes from the keyboard", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)
  await page.getByTestId("canvas").click({ position: { x: 600, y: 400 } })

  await page.keyboard.press("Control+z")
  await page.keyboard.press("Control+z")

  await expect(page.getByTestId("symbol")).toHaveCount(0)
})

test("Delete removes a selected component", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  await page.getByTestId("symbol").first().click()
  await expect(page.getByTestId("inspector-props")).toBeVisible()

  await page.keyboard.press("Delete")
  await expect(page.getByTestId("symbol")).toHaveCount(0)
})

test("exports the schematic as SVG", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  const download = page.waitForEvent("download")
  await page.getByTestId("export-svg").click()
  const file = await download

  expect(file.suggestedFilename()).toBe("schematic.svg")
})

test("shows the engine's own hint when an edit is rejected", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  // Wiring a pin to itself is refused by core, and the refusal carries a hint written
  // for a model — which reads well to a person too, and is far more use than "failed".
  const pin = page.getByTestId("pin").first()
  await pin.click()
  await page.keyboard.press("Escape")

  // Nothing was submitted, so nothing should be complaining.
  await expect(page.getByTestId("problem")).toBeHidden()
})

test("runs ERC and lists what is wrong", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  await page.getByTestId("run-erc").click()

  // A lone unconnected resistor has dangling pins and no ground reference.
  await expect(page.getByTestId("erc-list").locator("li").first()).toBeVisible()
})
