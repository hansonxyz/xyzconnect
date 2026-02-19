/**
 * English translations (source of truth).
 * All other locale files must have the same keys.
 */
export const en: Record<string, string> = {
  // App chrome
  'app.title': 'XYZConnect',
  'app.about': 'About XYZConnect',
  'app.newMessage': 'New message',
  'app.findPhone': 'Find my phone',
  'app.syncMessages': 'Sync messages',
  'app.settings': 'Settings',
  'app.sidebarPlaceholder': 'Connect a device to see conversations',
  'app.sidebarPlaceholderAlt': 'Conversations will appear here',
  'app.emptyState': 'Select a conversation to start messaging',

  // Status indicator
  'status.noDaemon': 'Daemon not running',
  'status.disconnected': 'No device connected',
  'status.discovering': 'Searching for devices...',
  'status.pairing': 'Pairing...',
  'status.connected': 'Device connected',
  'status.syncing': 'Syncing...',
  'status.ready': 'Ready',
  'status.error': 'Error',

  // Pairing page
  'pairing.starting': 'Starting...',
  'pairing.initializing': 'Initializing XYZConnect',
  'pairing.incomingRequest': 'Incoming Pairing Request',
  'pairing.wantsToPair': '{device} wants to pair',
  'pairing.verifyHint': 'Verify the code matches on your phone before accepting',
  'pairing.accept': 'Accept',
  'pairing.reject': 'Reject',
  'pairing.title': 'Pairing',
  'pairing.confirmCode': 'Confirm this code matches on your phone',
  'pairing.connectionError': 'Connection Error',
  'pairing.unexpectedError': 'An unexpected error occurred',
  'pairing.autoRecover': 'The daemon will attempt to recover automatically',
  'pairing.connectTitle': 'Connect to Your Phone',
  'pairing.searching': 'Searching for devices...',
  'pairing.dontSeePhone': "Don't see your phone?",
  'pairing.installKDE': 'Install',
  'pairing.kdeConnect': 'KDE Connect',
  'pairing.sameWifi': 'and connect to the same Wi-Fi network.',
  'pairing.getStarted': 'Get Started with KDE Connect',
  'pairing.installDescription': 'Install KDE Connect on your Android phone to sync your messages, contacts, and notifications with your computer.',
  'pairing.qrAlt': 'QR code to download KDE Connect from Google Play',
  'pairing.googlePlay': 'Get it on Google Play',
  'pairing.step1': 'Install KDE Connect on your phone',
  'pairing.step2': "Open the app and make sure you're on the same Wi-Fi network",
  'pairing.step3': 'Your phone will appear here automatically',
  'pairing.dismiss': 'Dismiss',

  // Device list
  'devices.pairedDevices': 'Paired Devices',
  'devices.offline': 'Offline',
  'devices.unpair': 'Unpair',
  'devices.nearbyDevices': 'Nearby Devices',
  'devices.pair': 'Pair',
  'devices.noDevices': 'No devices found nearby',

  // Conversations
  'conversations.loading': 'Loading conversations...',
  'conversations.noMatch': 'No conversations match your search',
  'conversations.empty': 'No conversations yet',

  // Search bar
  'search.placeholder': 'Search conversations...',
  'search.clear': 'Clear search',
  'search.showUnread': 'Show unread only',
  'search.showAll': 'Show all conversations',
  'search.filterSpam': 'Filter spam/unknown',

  // Message thread
  'messages.loading': 'Loading messages...',
  'messages.empty': 'No messages in this conversation',
  'messages.sending': 'Sending...',
  'messages.sent': 'Sent',
  'messages.failed': 'Failed to send',
  'messages.retry': 'Retry',
  'messages.cancel': 'Cancel',
  'messages.compose': 'Type a message...',
  'messages.send': 'Send message',
  'messages.emoji': 'Emoji',

  // Export
  'export.tooltip': 'Export conversation',
  'export.txt': 'Export as TXT',
  'export.csv': 'Export as CSV',
  'export.csvHeader': 'Date,From,Body',
  'export.me': 'Me',

  // Message bubble
  'bubble.saveAttachment': 'Save attachment',
  'bubble.mmsAlt': 'MMS attachment',
  'bubble.videoAlt': 'Video',
  'bubble.failedToLoad': 'Failed to load',
  'bubble.copyCode': 'Copy {code}',
  'bubble.codeCopied': '{code} copied to clipboard',

  // New conversation
  'newMessage.to': 'To:',
  'newMessage.changeRecipient': 'Change recipient',
  'newMessage.startNew': 'Start a new conversation',
  'newMessage.enterContact': 'Enter a contact name or phone number above',

  // Contact autocomplete
  'contacts.placeholder': 'Type a name or phone number...',

  // Settings panel
  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.connection': 'Connection',
  'settings.status': 'Status',
  'settings.device': 'Device',
  'settings.waitingDevice': 'Waiting for device...',
  'settings.ipAddress': 'IP Address',
  'settings.type': 'Type',
  'settings.statusConnected': 'Connected',
  'settings.statusReconnecting': 'Reconnecting',
  'settings.statusDisconnected': 'Disconnected',
  'settings.notifications': 'Notifications',
  'settings.desktopNotifications': 'Desktop notifications',
  'settings.flashTaskbar': 'Flash taskbar on new message',
  'settings.flashTaskbarHint': '(Windows)',
  'settings.language': 'Language',
  'settings.languageAuto': 'Auto (detect from system)',

  // Updates
  'updates.title': 'Updates',
  'updates.version': 'Version',
  'updates.checkAuto': 'Check automatically',
  'updates.checking': 'Checking for updates...',
  'updates.available': 'Version {version} available',
  'updates.upToDate': 'You are up to date',
  'updates.downloading': 'Downloading... {percent}%',
  'updates.ready': 'Version {version} ready to install',
  'updates.error': 'Update error: {message}',
  'updates.checkBtn': 'Check for Updates',
  'updates.checkingBtn': 'Checking...',
  'updates.viewOnGithub': 'View Update on GitHub',
  'updates.restartBtn': 'Restart to Update',

  // Update banner
  'banner.ready': 'Version {version} is ready to install.',
  'banner.restart': 'Restart to Update',
  'banner.later': 'Later',

  // Device settings section
  'settings.deviceSection': 'Device',
  'settings.unpairConfirm': "Unpair from {device}? You'll need to pair again to use XYZConnect.",
  'settings.unpairBtn': 'Unpair',
  'settings.unpairing': 'Unpairing...',
  'settings.cancelBtn': 'Cancel',
  'settings.unpairDevice': 'Unpair Device',
  'settings.aboutBtn': 'About XYZConnect',

  // Find my phone
  'findPhone.close': 'Close',
  'findPhone.title': 'Find My Phone',
  'findPhone.description': "This will make your phone ring at full volume, even if it's on silent.",
  'findPhone.ring': 'Ring Phone',
  'findPhone.ringing': 'Ringing...',
  'findPhone.ringingDesc': 'Your phone should be ringing now.',
  'findPhone.ringAgain': 'Ring Again',
  'findPhone.errorTitle': "Couldn't Ring Phone",
  'findPhone.tryAgain': 'Try Again',

  // About dialog
  'about.close': 'Close',
  'about.name': 'XYZConnect',
  'about.version': 'Version 0.1',
  'about.credit': '2026 by Brian Hanson',
  'about.releasedUnder': 'Released under the',
  'about.and': 'and',
  'about.acknowledgments': 'Acknowledgments',
  'about.kdeDesc': 'open protocol for phone-desktop communication',
  'about.ffmpegDesc': 'video transcoding and thumbnail generation',
  'about.electronDesc': 'cross-platform desktop framework',
  'about.svelteDesc': 'reactive UI framework',
  'about.sourceAvailable': 'Full license and source available at',
  'about.tagline': 'This software was provided in the spirit of open source, in the hope that it makes your life a little easier.',

  // Notification
  'notification.newMessage': 'New message received',

  // Time formatting
  'time.today': 'Today',
  'time.yesterday': 'Yesterday',
}

export default en
