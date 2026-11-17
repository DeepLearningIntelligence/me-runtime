import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AuthCapabilities } from "@rakazo/contracts";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../../lib/auth";
import { fetchAuthCapabilities } from "../../lib/auth-capabilities";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { submitClass } from "../../pages/Auth";
import { ensureFirstBot } from "../../pages/onboarding/first-bot";
import { startedFromInvite } from "./entry";

/**
 * The one onboarding path (ME-RUN-001 section 4): a person lands here signed in
 * after the phone door, walks name, email, WhatsApp, the invite meter, and
 * finishes on "You're connected". Every step does real work or says so; a
 * person who is already set up is moved to the portal instead of walking again.
 */

const PHONE_PERSON_NAME = "Phone person";
const LINK_POLL_MS = 3_000;

type Step = "name" | "email" | "whatsapp" | "link" | "meter" | "done";

// off-scale: 16px below md stops iOS Safari zooming into a focused field.
const fieldClass = "mt-2 h-12 rounded-xl px-4 text-[16px]/6 md:text-body-lg";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; accountName: string; hasWhatsapp: boolean; hasBot: boolean };

export function MeOnboardingPage() {
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [step, setStep] = useState<Step>("name");
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      rpc.me(),
      rpc.messaging.status(undefined).catch(() => null),
      rpc.bots.list().catch(() => []),
      fetchAuthCapabilities().catch(() => null),
    ])
      .then(([me, messaging, bots, caps]) => {
        if (!active) return;
        setCapabilities(caps);
        const hasWhatsapp = Boolean(
          messaging?.identities.some((identity) => identity.provider === "whatsapp"),
        );
        setLoad({
          kind: "ready",
          accountName: me.name,
          hasWhatsapp,
          hasBot: bots.length > 0,
        });
        // A person who is already set up does not walk the flow again; an
        // account without a bot always reaches the step that creates one, so
        // the empty-space route into this page cannot bounce.
        if (me.name !== PHONE_PERSON_NAME && hasWhatsapp && bots.length > 0) {
          navigate("/app", { replace: true });
          return;
        }
        setStep(me.name === PHONE_PERSON_NAME ? "name" : "link");
      })
      .catch(() => {
        if (active) navigate("/app", { replace: true });
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  function goTo(next: Step) {
    setStep(next);
  }

  return (
    <OnboardingFrame
      title={
        step === "name" ? (
          <Trans>What should we call you?</Trans>
        ) : step === "email" ? (
          <Trans>Add your email</Trans>
        ) : step === "whatsapp" ? (
          <Trans>Where will you use me.io?</Trans>
        ) : step === "link" ? (
          <Trans>Connect WhatsApp</Trans>
        ) : step === "meter" ? (
          <Trans>Invite friends</Trans>
        ) : (
          <Trans>You’re connected</Trans>
        )
      }
      busy={load.kind === "loading"}
    >
      {load.kind === "loading" ? null : step === "name" ? (
        <NameStep
          accountName={load.accountName}
          onDone={(saved) => {
            if (saved !== PHONE_PERSON_NAME) goTo("email");
          }}
        />
      ) : step === "email" ? (
        <EmailStep onSkip={() => goTo("whatsapp")} />
      ) : step === "whatsapp" ? (
        <WhatsAppChoiceStep onDone={() => goTo("link")} />
      ) : step === "link" ? (
        <LinkStep
          chatUrl={capabilities?.whatsappChatUrl ?? null}
          onLinked={() => goTo("meter")}
          onSkip={() => goTo("meter")}
        />
      ) : step === "meter" ? (
        <MeterStep onDone={() => goTo("done")} />
      ) : (
        <DoneStep
          chatUrl={capabilities?.whatsappChatUrl ?? null}
          toPortal={() => navigate("/app", { replace: true })}
        />
      )}
    </OnboardingFrame>
  );
}

function OnboardingFrame({
  title,
  busy,
  children,
}: {
  title: React.ReactNode;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center bg-background px-6 py-12 text-foreground">
      <div className="flex w-full max-w-[460px] flex-col items-center" aria-busy={busy}>
        <img
          src="/brand/me-mark.png"
          alt=""
          className="h-[74px] w-[74px] rounded-full bg-muted object-contain p-2"
        />
        <h1
          aria-live="polite"
          className="mb-7 mt-7 text-balance text-center text-display font-medium tracking-tight"
        >
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

function NameStep({
  accountName,
  onDone,
}: {
  accountName: string;
  onDone: (saved: string) => void;
}) {
  const [name, setName] = useState(accountName === PHONE_PERSON_NAME ? "" : accountName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (pending || !next) return;
    setPending(true);
    setError(null);
    try {
      const result = await authClient.updateUser({ name: next });
      if (result.error) {
        setError(errorText(result.error, t`Could not save your name`));
        return;
      }
      authClient.$store.notify("$sessionSignal");
      onDone(next);
    } catch {
      setError(t`Could not reach the server.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex w-full flex-col items-center" onSubmit={save}>
      <div className="w-full">
        <Label htmlFor={fieldId} className="text-muted-foreground">
          <Trans>Name</Trans>
        </Label>
        <Input
          id={fieldId}
          name="name"
          autoComplete="name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t`Your name`}
          className={fieldClass}
        />
      </div>
      <Button type="submit" size="lg" disabled={pending || !name.trim()} className={submitClass}>
        {pending ? <Trans>Saving…</Trans> : <Trans>Continue</Trans>}
      </Button>
      {error ? (
        <p role="alert" className="mt-3 w-full text-center text-body text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function EmailStep({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="flex w-full flex-col items-center">
      <p className="w-full text-center text-body text-muted-foreground">
        <Trans>
          Get your agent's work and updates by email. Google sign-in is not set up on this server
          yet.
        </Trans>
      </p>
      <Button type="button" size="lg" className={submitClass} onClick={onSkip}>
        <Trans>Skip for now</Trans>
      </Button>
    </div>
  );
}

function WhatsAppChoiceStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex w-full flex-col items-center">
      <div className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3">
        <WhatsAppMark />
        <span className="text-body font-medium">WhatsApp</span>
      </div>
      <Button type="button" size="lg" className={submitClass} onClick={onDone}>
        <Trans>Continue</Trans>
      </Button>
    </div>
  );
}

function LinkStep({
  chatUrl,
  onLinked,
  onSkip,
}: {
  chatUrl: string | null;
  onLinked: () => void;
  onSkip: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const linkedRef = useRef(onLinked);
  linkedRef.current = onLinked;

  useEffect(() => {
    // Per-run state: the timer and the mount guard die with the run, so a retry
    // or an unmount never leaves a poller behind.
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function issue() {
      try {
        const bot = await ensureFirstBot();
        const link = await rpc.messaging.link.start({ botId: bot.id });
        if (!active) return;
        setCode(link.code);
        setError(null);
      } catch (caught) {
        if (active) {
          setError(errorText(caught, t`Could not start the WhatsApp link. Try again.`));
        }
      }
    }
    async function poll() {
      try {
        const status = await rpc.messaging.status(undefined);
        if (status.identities.some((identity) => identity.provider === "whatsapp")) {
          if (timer) clearInterval(timer);
          if (active) linkedRef.current();
        }
      } catch {
        // A missed poll is retried by the interval; the code stays valid.
      }
    }
    void issue().then(() => {
      if (active) {
        void poll();
        timer = setInterval(() => void poll(), LINK_POLL_MS);
      }
    });
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [attempt]);

  if (!chatUrl) {
    return (
      <div className="flex w-full flex-col items-center">
        <p role="alert" className="w-full text-center text-body text-muted-foreground">
          <Trans>WhatsApp is not connected on this server yet.</Trans>
        </p>
        <Button type="button" variant="link" size="sm" className="mt-3" onClick={onSkip}>
          <Trans>Skip for now</Trans>
        </Button>
      </div>
    );
  }

  const openLink = code ? `${chatUrl}?text=${encodeURIComponent(code)}` : null;

  return (
    <div className="flex w-full flex-col items-center">
      {code ? (
        <>
          <Button
            type="button"
            size="lg"
            className={submitClass}
            render={<a href={openLink!} target="_blank" rel="noreferrer" />}
          >
            <Trans>Open WhatsApp</Trans>
          </Button>
          <p className="mt-3 w-full text-center text-body text-muted-foreground">
            <Trans>
              Send the pre-filled message from your WhatsApp. This page moves on when the connection
              lands.
            </Trans>
          </p>
        </>
      ) : error ? (
        <>
          <p role="alert" className="w-full text-center text-body text-destructive">
            {error}
          </p>
          <Button
            type="button"
            size="lg"
            className={submitClass}
            onClick={() => setAttempt((current) => current + 1)}
          >
            <Trans>Try again</Trans>
          </Button>
          <Button type="button" variant="link" size="sm" className="mt-3" onClick={onSkip}>
            <Trans>Skip for now</Trans>
          </Button>
        </>
      ) : (
        <p role="status" className="w-full text-center text-body text-muted-foreground">
          <Trans>Preparing your WhatsApp link…</Trans>
        </p>
      )}
      {!error ? (
        <Button type="button" variant="link" size="sm" className="mt-3" onClick={onSkip}>
          <Trans>Skip for now</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function MeterStep({ onDone }: { onDone: () => void }) {
  const [quota, setQuota] = useState<{ used: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpc.invites
      .list(undefined)
      .then((list) => {
        if (active) {
          setQuota({ used: list.quota.redeemedCount, total: list.quota.allocation });
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(errorText(caught, t`Could not load your invites.`));
      });
    return () => {
      active = false;
    };
  }, []);

  const share = quota && quota.total > 0 ? Math.min(1, quota.used / quota.total) : 0;

  return (
    <div className="flex w-full flex-col items-center">
      <div className="w-full">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={quota?.total ?? 10}
          aria-valuenow={quota?.used ?? 0}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <p className="mt-2 text-center text-body text-muted-foreground">
          {quota ? (
            <Trans>
              {quota.used} of {quota.total} invites used
            </Trans>
          ) : (
            t`Loading your invites…`
          )}
        </p>
      </div>
      <p className="mt-2 w-full text-center text-body">
        <Trans>Each friend who joins can connect their agents to yours.</Trans>
      </p>
      <Button type="button" size="lg" className={submitClass} onClick={onDone}>
        <Trans>Continue</Trans>
      </Button>
      {error ? (
        <p role="alert" className="mt-3 w-full text-center text-body text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DoneStep({ chatUrl, toPortal }: { chatUrl: string | null; toPortal: () => void }) {
  const invited = startedFromInvite();
  return (
    <div className="flex w-full flex-col items-center">
      <p className="w-full text-center text-body text-muted-foreground">
        <Trans>Your agents are ready in WhatsApp.</Trans>
      </p>
      {invited ? (
        <>
          {chatUrl ? (
            <Button
              type="button"
              size="lg"
              className={submitClass}
              render={<a href={chatUrl} target="_blank" rel="noreferrer" />}
            >
              <Trans>Back to WhatsApp</Trans>
            </Button>
          ) : (
            <Button type="button" size="lg" className={submitClass} onClick={toPortal}>
              <Trans>Open the portal</Trans>
            </Button>
          )}
          <Button type="button" variant="link" size="sm" className="mt-3" onClick={toPortal}>
            <Trans>Open the portal</Trans>
          </Button>
        </>
      ) : (
        <>
          <Button type="button" size="lg" className={submitClass} onClick={toPortal}>
            <Trans>Open the portal</Trans>
          </Button>
          {chatUrl ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mt-3"
              render={<a href={chatUrl} target="_blank" rel="noreferrer" />}
            >
              <Trans>Chat in WhatsApp</Trans>
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** WhatsApp's own glyph; the one real brand icon this flow needs. */
function WhatsAppMark() {
  return (
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full">
      <svg viewBox="0 0 24 24" className="size-9" role="presentation">
        <circle cx="12" cy="12" r="12" fill="#25D366" />
        <path
          className="fill-white"
          d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.347-.347.52-.52.174-.174.232-.298.347-.497.116-.199.058-.372-.03-.52-.086-.149-.66-1.59-.905-2.18-.24-.573-.485-.496-.66-.505l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"
        />
      </svg>
    </span>
  );
}
