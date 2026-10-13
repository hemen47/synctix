/**
 * Viewport arithmetic: pixels to millimetres and back.
 *
 * Small enough to inline at every call site, which is exactly why it should not be — a
 * sign error in one of these is invisible in code review and obvious only as a canvas
 * that pans the wrong way.
 */

import type { Point, Scene, Viewport } from "./types"

export const createViewport = (widthPx: number, heightPx: number): Viewport => ({
  offset: { x: 0, y: 0 },
  // 18 px/mm. A schematic symbol is only a few millimetres across, so at the 8 px/mm this
  // used to open at a resistor was about twenty pixels wide — legible if you already knew
  // what it was, and a speck if you did not. This is roughly the density a schematic is
  // drawn at on paper, and Fit still frames anything larger.
  scale: 18,
  widthPx,
  heightPx,
})

export const toWorld = (viewport: Viewport, screen: Point): Point => ({
  x: viewport.offset.x + screen.x / viewport.scale,
  y: viewport.offset.y + screen.y / viewport.scale,
})

export const toScreen = (viewport: Viewport, world: Point): Point => ({
  x: (world.x - viewport.offset.x) * viewport.scale,
  y: (world.y - viewport.offset.y) * viewport.scale,
})

/**
 * Zoom about a fixed screen point.
 *
 * The point under the cursor has to stay under the cursor, or scroll-wheel zoom feels
 * like the drawing is sliding away.
 */
export const zoomAt = (viewport: Viewport, screen: Point, factor: number): Viewport => {
  const scale = clamp(viewport.scale * factor, 0.5, 400)
  const before = toWorld(viewport, screen)
  const after = { x: before.x - screen.x / scale, y: before.y - screen.y / scale }
  return { ...viewport, scale, offset: after }
}

export const panBy = (viewport: Viewport, deltaPx: Point): Viewport => ({
  ...viewport,
  offset: {
    x: viewport.offset.x - deltaPx.x / viewport.scale,
    y: viewport.offset.y - deltaPx.y / viewport.scale,
  },
})

/** Fit the whole scene with a margin, or centre on the origin when it is empty. */
export const fitToScene = (viewport: Viewport, scene: Scene, marginMm = 5): Viewport => {
  const { minX, minY, maxX, maxY } = scene.bounds
  const width = maxX - minX
  const height = maxY - minY

  if (width <= 0 || height <= 0) {
    return {
      ...viewport,
      scale: 8,
      offset: { x: -viewport.widthPx / 16, y: -viewport.heightPx / 16 },
    }
  }

  const scale = clamp(
    Math.min(
      viewport.widthPx / (width + marginMm * 2),
      viewport.heightPx / (height + marginMm * 2),
    ),
    0.5,
    400,
  )

  return {
    ...viewport,
    scale,
    offset: {
      x: minX - (viewport.widthPx / scale - width) / 2,
      y: minY - (viewport.heightPx / scale - height) / 2,
    },
  }
}

/** The world rectangle currently visible, for culling what is drawn. */
export const visibleRect = (
  viewport: Viewport,
): { minX: number; minY: number; maxX: number; maxY: number } => ({
  minX: viewport.offset.x,
  minY: viewport.offset.y,
  maxX: viewport.offset.x + viewport.widthPx / viewport.scale,
  maxY: viewport.offset.y + viewport.heightPx / viewport.scale,
})

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)
