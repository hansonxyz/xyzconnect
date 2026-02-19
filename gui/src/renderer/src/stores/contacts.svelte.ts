/**
 * Contacts Store
 *
 * Loads all contacts from daemon, builds a normalized phone → contact
 * lookup map, and refreshes on contacts.updated notifications.
 */

import { normalizePhone } from '../lib/phone'

export const contacts = $state({
  list: [] as ContactRow[],
  loading: false,
  /** Map of normalized phone number → ContactRow for O(1) lookup */
  byPhone: new Map<string, ContactRow>(),
})

/** Look up a contact by raw phone number. */
export function findContactByPhone(phone: string): ContactRow | undefined {
  return contacts.byPhone.get(normalizePhone(phone))
}

/** Refresh contacts from daemon. */
export async function refreshContacts(): Promise<void> {
  contacts.loading = true
  try {
    const rows = (await window.api.invoke('contacts.list')) as ContactRow[]
    contacts.list.length = 0
    contacts.list.push(...rows)
    rebuildPhoneMap()
  } catch {
    // Not connected or error — leave current state
  } finally {
    contacts.loading = false
  }
}

function rebuildPhoneMap(): void {
  contacts.byPhone.clear()
  for (const contact of contacts.list) {
    // phone_numbers is semicolon-separated
    const phones = contact.phone_numbers.split(';').filter(Boolean)
    for (const phone of phones) {
      contacts.byPhone.set(normalizePhone(phone), contact)
    }
  }
}

/**
 * Initialize the contacts store. Call from App.svelte onMount.
 * Returns a cleanup function.
 */
export function initContactsStore(): () => void {
  const handleNotification = (method: string, _params: unknown): void => {
    if (method === 'contacts.updated') {
      void refreshContacts()
    }
  }

  window.api.onNotification(handleNotification)

  return () => {
    window.api.offNotification(handleNotification)
  }
}
