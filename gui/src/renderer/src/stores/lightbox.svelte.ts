/**
 * Lightbox Store
 *
 * Manages the full-screen media viewer state.
 * Opening the lightbox shows an image or video in an overlay.
 */

interface LightboxState {
  type: 'image' | 'video'
  src: string
  partId: number
  messageId: number
}

let current: LightboxState | null = $state(null)

export function openLightbox(type: 'image' | 'video', src: string, partId: number, messageId: number): void {
  current = { type, src, partId, messageId }
}

export function closeLightbox(): void {
  current = null
}

export const lightbox: { current: LightboxState | null } = {
  get current(): LightboxState | null {
    return current
  },
}
