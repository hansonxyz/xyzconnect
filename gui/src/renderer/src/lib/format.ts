/**
 * Date/Time Formatting
 *
 * Formats timestamps for conversation list display.
 */

/**
 * Format a timestamp for the conversation list sidebar.
 * - Today: "3:42 PM"
 * - Yesterday: "Yesterday"
 * - This week: "Wednesday"
 * - This year: "Jan 15"
 * - Older: "1/15/24"
 */
export function formatConversationTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.floor((today.getTime() - messageDay.getTime()) / 86400000)

  if (diffDays === 0) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  if (diffDays === 1) {
    return 'Yesterday'
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
  })
}
