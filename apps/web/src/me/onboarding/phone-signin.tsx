import { Trans, useLingui } from "@lingui/react/macro";
import { Button, InputOTP, InputOTPGroup, InputOTPSlot } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { authClient } from "../../lib/auth";
import type { DoorRefusal, StartedDoor } from "./door";
import { doorRefusal, startPhoneDoor, verifyPhoneDoor } from "./door";
import { rememberWhatsappLink } from "./entry";

const CODE_LENGTH = 6;
const codeFieldClass = "size-12 text-heading3 first:rounded-l-xl last:rounded-r-xl";
const primaryClass = "mt-3 h-12 w-full rounded-xl text-body-lg";

/**
 * The open door, kept by the browser for one sign-in journey (session storage,
 * the same way the entry flag is kept): WhatsApp now opens in the same tab, so
 * coming back lands on a reload, and the code field must still be there with
 * the nonce the server still knows. An expired door loads as no door at all.
 */

const DOOR_KEY = "me.phone-door";

function loadDoor(inviteToken: string | undefined): StartedDoor | null {
  try {
    const raw = window.sessionStorage.getItem(DOOR_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { door?: StartedDoor; inviteToken?: string | null };
    if (saved.inviteToken !== (inviteToken ?? null) || !saved.door) return null;
    const door = saved.door;
    if (
      typeof door.nonce !== "string" ||
      typeof door.waLink !== "string" ||
      typeof door.businessNumber !== "string" ||
      typeof door.expiresAt !== "string" ||
      typeof door.ttlMs !== "number"
    ) {
      return null;
    }
    if (Date.parse(door.expiresAt) <= Date.now()) return null;
    return door;
  } catch {
    // Unreadable storage opens as no door; the person starts over.
    return null;
  }
}

function saveDoor(door: StartedDoor | null, inviteToken?: string): void {
  try {
    if (door) {
      window.sessionStorage.setItem(
        DOOR_KEY,
        JSON.stringify({ door, inviteToken: inviteToken ?? null }),
      );
    } else window.sessionStorage.removeItem(DOOR_KEY);
  } catch {
    // Blocked storage only loses the round trip; the door still works in one stretch.
  }
}

/**
 * The phone door's screen (D-RUN-5): the person taps the wa.me link, which
 * sends `ME-<nonce>` from their own WhatsApp, and types the code the business
 * line replies with. The number is learned from that message, so it is never
 * asked for. The invite token the welcome page carried rides with the start
 * call, because account creation is invite-only. An invite refusal stays on
 * screen until a new door opens: a later failure must not push the real
 * reason, and its next step, off the screen.
 */
export function PhoneDoorPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get("invite") ?? undefined;
  const [attempt, setDoor] = useState(() => ({
    door: loadDoor(inviteToken),
    inviteToken,
  }));
  const door = attempt.inviteToken === inviteToken ? attempt.door : null;
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<DoorRefusal | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyCode() {
    if (!door) return;
    try {
      await navigator.clipboard.writeText(door.nonce);
      setCopied(true);
    } catch {
      // No clipboard access: the button keeps saying Copy, the code stays on
      // screen to send by hand.
      setCopied(false);
    }
  }

  async function openDoor() {
    if (pending) return;
    setPending(true);
    setRefusal(null);
    try {
      const started = await startPhoneDoor({ inviteToken: inviteToken || undefined });
      if (mounted.current) {
        setDoor({ door: started, inviteToken });
        saveDoor(started, inviteToken);
        setCode("");
      }
    } catch (caught) {
      if (mounted.current) setRefusal((current) => doorRefusal(current, caught));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function verifyCode(value: string) {
    if (!door || pending || value.length < CODE_LENGTH) return;
    setPending(true);
    try {
      const result = await verifyPhoneDoor({ nonce: door.nonce, code: value });
      // The session cookie is set; the store refetches, and the routes move
      // the person on once the session lands. The WhatsApp link state rides
      // with the journey to the onboarding flow.
      rememberWhatsappLink(result.whatsapp);
      saveDoor(null);
      authClient.$store.notify("$sessionSignal");
      onSignedIn();
    } catch (caught) {
      if (mounted.current) {
        setRefusal((current) => doorRefusal(current, caught));
        setCode("");
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  function restart() {
    setDoor({ door: null, inviteToken });
    saveDoor(null);
    setCode("");
    setRefusal(null);
  }

  const minutes = door ? Math.max(1, Math.round(door.ttlMs / 60_000)) : 0;

  return (
    <div className="flex w-full flex-col items-center">
      {door ? (
        <>
          <Button
            type="button"
            size="lg"
            disabled={pending}
            className={primaryClass}
            render={<a href={door.waLink} />}
          >
            <Trans>Open WhatsApp</Trans>
          </Button>
          <p className="mt-3 w-full text-center text-body text-muted-foreground">
            <Trans>
              Send the pre-filled message. Your code arrives in WhatsApp and expires in {minutes}{" "}
              minutes.
            </Trans>
          </p>
          <p className="mt-6 w-full text-center text-heading2 font-medium tracking-wide">
            {door.nonce}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            aria-label={t({ message: "Copy sign-in code", context: "WhatsApp sign-in" })}
            onClick={() => void copyCode()}
          >
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </Button>
          <p className="mt-2 w-full text-center text-body text-muted-foreground">
            <Trans>
              Or send this code on WhatsApp to{" "}
              <span className="whitespace-nowrap">{door.businessNumber}</span>
            </Trans>
          </p>
          <div className="mt-6 flex w-full justify-center">
            <InputOTP
              aria-label={t({ message: "Code", context: "WhatsApp sign-in" })}
              maxLength={CODE_LENGTH}
              pattern={"^\\d+$"}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={(value: string) => void verifyCode(value)}
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <InputOTPSlot key={index} index={index} className={codeFieldClass} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
          <Button
            type="button"
            size="lg"
            disabled={pending || code.length < CODE_LENGTH}
            className={primaryClass}
            onClick={() => void verifyCode(code)}
          >
            {pending ? <Trans>Checking…</Trans> : <Trans>Verify</Trans>}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={pending}
            className="mt-3 text-muted-foreground"
            onClick={restart}
          >
            <Trans>Start over</Trans>
          </Button>
        </>
      ) : (
        <>
          <p className="w-full text-center text-body text-muted-foreground">
            <Trans>We send a sign-in code to your WhatsApp. No password.</Trans>
          </p>
          <Button
            type="button"
            size="lg"
            disabled={pending}
            className={primaryClass}
            onClick={() => void openDoor()}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Continue</Trans>}
          </Button>
        </>
      )}
      {refusal ? (
        <p role="alert" className="mt-3 w-full text-center text-body text-destructive">
          {refusal.text}
        </p>
      ) : null}
    </div>
  );
}
