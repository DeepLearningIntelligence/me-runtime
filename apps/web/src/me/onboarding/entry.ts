/**
 * How this browser session reached the product. A person who opened an invite
 * link arrived from WhatsApp, so onboarding ends by sending them back there;
 * a person who arrived on the web ends in the portal with WhatsApp offered.
 * Session storage: the flag belongs to one sign-in journey, not to the person.
 */

const ENTRY_KEY = "me.started-from";

export type EntryOrigin = "invite" | "web";

export function rememberInviteEntry(): void {
  try {
    window.sessionStorage.setItem(ENTRY_KEY, "invite");
  } catch {
    // Blocked storage only loses the "Back to WhatsApp" ending; the flow still works.
  }
}

export function startedFromInvite(): boolean {
  try {
    return window.sessionStorage.getItem(ENTRY_KEY) === "invite";
  } catch {
    return false;
  }
}
