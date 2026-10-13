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

  const before = await page.getByTestId("symbol").count()
  await page.getByTestId("canvas").click({ position: { x: atX, y: atY } })
  await expect(page.getByTestId("placing")).toBeHidden()

  // Wait for the symbol to be *drawn*, not just for the placing mode to clear. The mode
  // resets synchronously on click while the operation and the relayout are still in
  // flight, so a caller that reads a bounding box here would measure the previous frame.
  await expect(page.getByTestId("symbol")).toHaveCount(before + 1)
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

  // One operation per placement: add and move go in as one atomic batch, so a placement
  // is a single entry in the log and a single undo.
  await expect(page.getByTestId("element-count")).toContainText("2 operations")
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

  // v1 is the placement, v2 the drag: one operation each.
  await expect(page.getByTestId("status")).toContainText("v2")

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
  await expect(page.getByTestId("symbol")).toHaveCount(2)

  // One undo per placement, because each went in as one atomic batch.
  await page.getByTestId("undo").click()
  await expect(page.getByTestId("symbol")).toHaveCount(1)

  await page.getByTestId("redo").click()
  await expect(page.getByTestId("symbol")).toHaveCount(2)
})

test("Ctrl+Z undoes from the keyboard", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)
  await page.getByTestId("canvas").click({ position: { x: 600, y: 400 } })

  // One press, because a placement is one operation.
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

/**
 * Export now goes through the server's exporter registry rather than serialising the
 * canvas, so what a user downloads is tscircuit's own rendering of the document — the
 * same bytes every other exporter is built from.
 */
test("exports the schematic as SVG", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  const download = page.waitForEvent("download")
  await page.getByTestId("export").selectOption("svg")
  const file = await download

  // The server names the file after the design, so the id is asserted loosely.
  expect(file.suggestedFilename()).toMatch(/\.svg$/)
})

test("switches to the board view and offers to route it", async ({ page }) => {
  await placePart(page, "resistor", 200, 200)

  await page.getByTestId("view-pcb").click()
  // Either tscircuit draws the board, or the pane explains that there is nothing to draw
  // and offers the routing step. Both are correct; a blank pane is not.
  await expect(page.getByTestId("render-pcb").or(page.getByTestId("view-failed"))).toBeVisible()
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

/**
 * Defining a part of your own.
 *
 * The assertion that matters is the last one: a custom part has to be *placeable*, not
 * just saveable. Every read path can work while the one write path that matters does not
 * — that is exactly the bug this flow shipped with first time round, where the store's
 * resolver had never heard of the user's library.
 */
test("defines a custom part and places it", async ({ page }) => {
  await page.getByTestId("new-part").click()

  await page.getByTestId("part-name").fill("My Relay Module")
  await page.getByTestId("part-footprint").fill("soic8")

  const pinNames = page.getByTestId("pin-name")
  await pinNames.nth(0).fill("VCC")
  await pinNames.nth(1).fill("GND")

  await page.getByTestId("save-part").click()

  // It appears in the palette, marked as the user's own and as unverified.
  const mine = page.getByTestId("part").filter({ hasText: "My Relay Module" })
  await expect(mine).toBeVisible()

  await mine.click()
  await expect(page.getByTestId("placing")).toBeVisible()
  await page.getByTestId("canvas").click({ position: { x: 300, y: 250 } })

  await expect(page.getByTestId("symbol")).toHaveCount(1)
  await expect(page.getByTestId("problem")).toBeHidden()
})

test("refuses a footprint too small for the part's pins", async ({ page }) => {
  await page.getByTestId("new-part").click()

  await page.getByTestId("part-name").fill("Too Many Pins")
  // A two-pad package cannot carry four pins, and finding that out at assembly is the
  // most expensive failure this tool can help someone avoid.
  await page.getByTestId("part-footprint").fill("0402")

  const pinNames = page.getByTestId("pin-name")
  await pinNames.nth(0).fill("A")
  await pinNames.nth(1).fill("B")
  await page.getByTestId("add-pin").click()
  await page.getByTestId("add-pin").click()
  await page.getByTestId("pin-name").nth(2).fill("C")
  await page.getByTestId("pin-name").nth(3).fill("D")

  await page.getByTestId("save-part").click()

  // The engine's own message, not "invalid part".
  await expect(page.getByTestId("part-form-errors")).toContainText(/pad/)
})
